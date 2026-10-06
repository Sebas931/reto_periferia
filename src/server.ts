import { serve } from "@hono/node-server"
import { Hono, type Context, type Next } from "hono"
import { streamSSE } from "hono/streaming"
import { readFile, rm } from "node:fs/promises"
import { dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { ejecutarTurno, type DependenciasCiclo, type EventoTurno } from "./agente/ciclo.ts"
import { cargarSystemPrompt } from "./agente/prompt.ts"
import { AlmacenSesiones, idValido } from "./agente/sesiones.ts"
import { leerConfig } from "./config.ts"
import { listarDirectorios, rutaSalida } from "./dominio/archivos.ts"
import type { AdaptadorLlm, Uso } from "./llm/adapter.ts"
import { AdaptadorAnthropic } from "./llm/anthropic.ts"
import { nombresHerramientas } from "./tools/registro.ts"

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..")
// .env es opcional en local; en el hosting las variables vienen del entorno.
try {
  process.loadEnvFile(join(RAIZ, ".env"))
} catch {
  // sin .env
}
const config = leerConfig()
const system = await cargarSystemPrompt(RAIZ)
const sesiones = new AlmacenSesiones(RAIZ, config.MAX_SESIONES)

const llm: AdaptadorLlm = new AdaptadorAnthropic({
  modelo: config.LLM_MODEL,
  esfuerzo: config.LLM_EFFORT,
  maxTokens: config.LLM_MAX_TOKENS,
  timeoutMs: config.LLM_TIMEOUT_MS,
})

/** Tope global diario de tokens (protege la clave del proveedor en un link público). */
const presupuesto = (() => {
  let dia = new Date().toISOString().slice(0, 10)
  let usados = 0
  const reiniciarSiCambioDia = () => {
    const hoy = new Date().toISOString().slice(0, 10)
    if (hoy !== dia) {
      dia = hoy
      usados = 0
    }
  }
  return {
    disponible: () => (reiniciarSiCambioDia(), usados < config.MAX_TOKENS_DIA),
    consumir: (u: Uso) => {
      reiniciarSiCambioDia()
      usados += u.entrada + u.salida + u.cacheLectura + u.cacheEscritura
    },
  }
})()

const deps: DependenciasCiclo = {
  llm,
  system,
  directorio: RAIZ,
  maxIteraciones: config.MAX_ITERACIONES,
  maxTokensSesion: config.MAX_TOKENS_SESION,
  presupuestoGlobal: presupuesto,
}

// ── Límite simple de mensajes por IP ────────────────────────────────────
const ventanas = new Map<string, number[]>()
function permitido(ip: string, maxPorMinuto = 20): boolean {
  const ahora = Date.now()
  const recientes = (ventanas.get(ip) ?? []).filter((t) => ahora - t < 60_000)
  recientes.push(ahora)
  ventanas.set(ip, recientes)
  return recientes.length <= maxPorMinuto
}
const ipDe = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"

// ── App ─────────────────────────────────────────────────────────────────
const app = new Hono()

async function exigirClave(c: Context, next: Next) {
  if (!config.ACCESS_KEY) return next()
  const clave = c.req.header("x-access-key") ?? c.req.query("key")
  if (clave !== config.ACCESS_KEY) return c.json({ ok: false, error: "clave de acceso inválida" }, 401)
  return next()
}

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    provider: llm.proveedor,
    model: llm.modelo,
    effort: config.LLM_EFFORT,
    llmConfigurado: config.tieneClaveLlm,
    requiereClave: Boolean(config.ACCESS_KEY),
    herramientas: nombresHerramientas(),
  }),
)

app.use("/api/chat/*", exigirClave)
app.use("/api/chat", exigirClave)
app.use("/api/sessions/*", exigirClave)
app.use("/api/reset", exigirClave)
app.use("/out/*", exigirClave)

const CuerpoChat = z.object({
  sessionId: z.string().optional(),
  message: z.string().trim().min(1, "el mensaje está vacío").max(4000, "el mensaje es demasiado largo"),
})

type Preparacion =
  | { ok: true; sesion: Awaited<ReturnType<AlmacenSesiones["obtenerOCrear"]>>; mensaje: string }
  | { ok: false; estado: 400 | 409 | 429 | 503; error: string }

async function prepararTurno(c: Context): Promise<Preparacion> {
  if (!permitido(ipDe(c))) return { ok: false, estado: 429, error: "Demasiados mensajes seguidos. Espera un minuto." }
  if (!config.tieneClaveLlm) {
    return { ok: false, estado: 503, error: "El servidor no tiene configurada ANTHROPIC_API_KEY. Las herramientas se pueden probar con demo.ts." }
  }
  const cuerpo = CuerpoChat.safeParse(await c.req.json().catch(() => null))
  if (!cuerpo.success) return { ok: false, estado: 400, error: cuerpo.error.issues.map((i) => i.message).join("; ") }
  const sesion = await sesiones.obtenerOCrear(cuerpo.data.sessionId)
  if (sesion.ocupada) return { ok: false, estado: 409, error: "La sesión ya está procesando un mensaje. Espera a que termine." }
  return { ok: true, sesion, mensaje: cuerpo.data.message }
}

/** POST /api/chat → respuesta completa en JSON. */
app.post("/api/chat", async (c) => {
  const prep = await prepararTurno(c)
  if (!prep.ok) return c.json({ ok: false, error: prep.error }, prep.estado)
  const { sesion, mensaje } = prep
  sesion.ocupada = true
  try {
    const r = await ejecutarTurno(sesion, mensaje, deps)
    return c.json({ ok: true, sessionId: sesion.id, ...r })
  } finally {
    sesion.ocupada = false
    await sesiones.guardar(sesion)
  }
})

/** POST /api/chat/stream → eventos SSE: pensando, herramienta_inicio, herramienta_fin, texto, fin. */
app.post("/api/chat/stream", async (c) => {
  const prep = await prepararTurno(c)
  if (!prep.ok) return c.json({ ok: false, error: prep.error }, prep.estado)
  const { sesion, mensaje } = prep
  sesion.ocupada = true
  return streamSSE(c, async (stream) => {
    const enviar = (e: EventoTurno) => {
      void stream.writeSSE({ event: e.tipo, data: JSON.stringify(e) })
    }
    try {
      await stream.writeSSE({ event: "sesion", data: JSON.stringify({ sessionId: sesion.id }) })
      const r = await ejecutarTurno(sesion, mensaje, deps, enviar)
      await stream.writeSSE({ event: "fin", data: JSON.stringify({ sessionId: sesion.id, ...r }) })
    } finally {
      sesion.ocupada = false
      await sesiones.guardar(sesion)
    }
  })
})

/** GET /api/sessions/:id → historial visible completo (mensajes, llamadas a herramientas, confirmaciones). */
app.get("/api/sessions/:id", async (c) => {
  const id = c.req.param("id")
  if (!idValido(id)) return c.json({ ok: false, error: "id de sesión inválido" }, 400)
  const s = await sesiones.obtener(id)
  if (!s) return c.json({ ok: false, error: "sesión no encontrada" }, 404)
  return c.json({ ok: true, id: s.id, creada: s.creada, pendientes: s.pendientes, uso: s.uso, transcripcion: s.transcripcion })
})

/** POST /api/reset → borra las OC y archivos generados para repetir la demo (conserva sesiones). */
app.post("/api/reset", async (c) => {
  const salida = rutaSalida(RAIZ)
  for (const nombre of ["sap", "control.csv", "log.jsonl"]) await rm(join(salida, nombre), { recursive: true, force: true })
  for (const caso of await listarDirectorios(salida)) {
    if (/^sol-\d{3}$/.test(caso)) await rm(join(salida, caso), { recursive: true, force: true })
  }
  return c.json({ ok: true })
})

// ── Archivos generados (solo una lista blanca dentro de out/) ───────────
const ARCHIVO_PUBLICO = /^(sol-\d{3}\/(payload\.json|trazabilidad\.json|aprobacion\.txt|aprobacion\.pdf|oc\.json)|control\.csv|sap\/ordenes\.jsonl)$/
const TIPOS: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
}
app.get("/out/*", async (c) => {
  const relativa = c.req.path.replace(/^\/out\//, "")
  if (!ARCHIVO_PUBLICO.test(relativa)) return c.json({ ok: false, error: "archivo no disponible" }, 404)
  try {
    const contenido = await readFile(rutaSalida(RAIZ, ...relativa.split("/")))
    return c.body(contenido, 200, { "content-type": TIPOS[extname(relativa)] ?? "application/octet-stream" })
  } catch {
    return c.json({ ok: false, error: "el archivo aún no se ha generado" }, 404)
  }
})

// ── Front ───────────────────────────────────────────────────────────────
const ESTATICOS: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/estilos.css": ["estilos.css", "text/css; charset=utf-8"],
}
for (const [ruta, [archivo, tipo]] of Object.entries(ESTATICOS)) {
  app.get(ruta, async (c) => c.body(await readFile(join(RAIZ, "web", archivo)), 200, { "content-type": tipo, "cache-control": "no-cache" }))
}

app.onError((e, c) => {
  console.error(`[error] ${c.req.method} ${c.req.path}: ${e.message}`)
  return c.json({ ok: false, error: "error interno del servidor" }, 500)
})

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Agente OC escuchando en http://localhost:${info.port}`)
  console.log(`Modelo: ${llm.proveedor}/${llm.modelo} (esfuerzo ${config.LLM_EFFORT}) · clave LLM: ${config.tieneClaveLlm ? "configurada" : "NO configurada"}`)
})
