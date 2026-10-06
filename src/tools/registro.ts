import { z } from "zod"
import { agregarLinea, rutaSalida } from "../dominio/archivos.ts"
import { mensajeDeError } from "../dominio/resultado.ts"
import type { ContextoHerramienta, Herramienta } from "./contrato.ts"
import * as oc from "./oc.ts"

/** Lo que el adaptador LLM necesita saber de cada herramienta (independiente del proveedor). */
export type DefinicionHerramienta = { nombre: string; descripcion: string; esquema: Record<string, unknown> }

// Mensajes de validación de zod en español (los lee el modelo y la analista).
z.config(z.locales.es())

type HerramientaGenerica = Herramienta<z.ZodRawShape>

/** Orden en que el modelo ve las herramientas: el del flujo del proceso. */
const ORDEN = ["listar_solicitudes", "leer_paquete", "validar", "construir_payload", "generar_evidencia", "crear"]
const posicion = (nombre: string) => (ORDEN.includes(nombre) ? ORDEN.indexOf(nombre) : ORDEN.length)

/** Nombre visible para el modelo: <archivo>_<export>. */
const HERRAMIENTAS: Record<string, HerramientaGenerica> = Object.fromEntries(
  Object.entries(oc)
    .sort(([a], [b]) => posicion(a) - posicion(b))
    .map(([exportName, h]) => [`oc_${exportName}`, h as unknown as HerramientaGenerica]),
)

export const nombresHerramientas = (): string[] => Object.keys(HERRAMIENTAS)

export function definicionesHerramientas(): DefinicionHerramienta[] {
  return Object.entries(HERRAMIENTAS).map(([nombre, h]) => {
    const { $schema: _, ...esquema } = z.toJSONSchema(z.object(h.args)) as Record<string, unknown>
    return { nombre, descripcion: h.description, esquema }
  })
}

export type ResultadoEjecucion = {
  nombre: string
  argumentos: unknown
  /** JSON devuelto por la herramienta (lo que ve el modelo). */
  salida: string
  ok: boolean
  resumen: string
  caso: string | null
  codigo: string | null
  /** data.requiere_confirmacion o error REQUIERE_CONFIRMACION / CONFIRMACION_NO_HUMANA. */
  pideConfirmacion: boolean
  ocCreada: boolean
  duracionMs: number
}

type SalidaParseada = {
  ok?: boolean
  error?: string
  codigo?: string
  caso?: string
  data?: { resumen?: string; caso?: string; requiere_confirmacion?: boolean; numero_oc?: string }
}

function interpretar(salida: string): SalidaParseada {
  try {
    return JSON.parse(salida) as SalidaParseada
  } catch {
    return { ok: false, error: "la herramienta devolvió un resultado no JSON" }
  }
}

/**
 * Punto único de ejecución (servidor y demo.ts): valida argumentos con zod, ejecuta,
 * y deja la traza en out/log.jsonl (CA4 / RN). Nunca lanza.
 */
export async function ejecutarHerramienta(nombre: string, argumentos: unknown, ctx: ContextoHerramienta): Promise<ResultadoEjecucion> {
  const inicio = Date.now()
  const h = HERRAMIENTAS[nombre]
  let salida: string
  if (!h) {
    salida = JSON.stringify({ ok: false, error: `herramienta desconocida: ${nombre}. Disponibles: ${nombresHerramientas().join(", ")}` })
  } else {
    const validados = z.object(h.args).safeParse(argumentos ?? {})
    if (!validados.success) {
      const detalle = validados.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
      salida = JSON.stringify({ ok: false, error: `argumentos inválidos para ${nombre}: ${detalle}` })
    } else {
      try {
        salida = await h.execute(validados.data, ctx)
      } catch (e) {
        salida = JSON.stringify({ ok: false, error: `error interno: ${mensajeDeError(e)}` })
      }
    }
  }

  const p = interpretar(salida)
  const ok = p.ok === true
  const casoArg = (argumentos as { caso?: unknown } | null)?.caso
  const resultado: ResultadoEjecucion = {
    nombre,
    argumentos,
    salida,
    ok,
    resumen: ok ? (p.data?.resumen ?? "ok") : (p.error ?? "error"),
    caso: p.data?.caso ?? p.caso ?? (typeof casoArg === "string" ? casoArg : null),
    codigo: p.codigo ?? null,
    pideConfirmacion:
      (ok && p.data?.requiere_confirmacion === true) ||
      p.codigo === "REQUIERE_CONFIRMACION" ||
      p.codigo === "CONFIRMACION_NO_HUMANA",
    ocCreada: ok && nombre === "oc_crear" && typeof p.data?.numero_oc === "string",
    duracionMs: Date.now() - inicio,
  }

  await registrarLog(ctx, resultado)
  return resultado
}

async function registrarLog(ctx: ContextoHerramienta, r: ResultadoEjecucion): Promise<void> {
  try {
    const linea = {
      ts: new Date().toISOString(),
      sesion: ctx.sessionId,
      herramienta: r.nombre,
      caso: r.caso,
      ok: r.ok,
      codigo: r.codigo,
      resumen: r.resumen,
      ms: r.duracionMs,
    }
    await agregarLinea(rutaSalida(ctx.directory, "log.jsonl"), JSON.stringify(linea))
  } catch {
    // El log nunca debe tumbar la ejecución de una herramienta.
  }
}
