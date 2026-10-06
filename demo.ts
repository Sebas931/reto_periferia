/**
 * Verificación sin modelo de lenguaje (PRD 6.6): procesa los 6 casos llamando directamente
 * a las mismas herramientas que usa el agente. No necesita ninguna clave.
 *
 *   npm run demo        (o: npx tsx demo.ts)
 */
import { rm } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { leerTexto, rutaSalida } from "./src/dominio/archivos.ts"
import type { ContextoHerramienta } from "./src/tools/contrato.ts"
import { ejecutarHerramienta, type ResultadoEjecucion } from "./src/tools/registro.ts"

const directory = dirname(fileURLToPath(import.meta.url))
const ctx: ContextoHerramienta = { directory, sessionId: "demo" }

type Datos = Record<string, unknown> & {
  apta?: boolean
  retroactiva?: boolean
  bloqueos?: Array<{ codigo: string; detalle: string; accion_sugerida: string }>
  confirmaciones?: Array<{ codigo: string; detalle: string }>
  derivados?: Record<string, { valor: string; motivo: string }>
  numero_oc?: string
  idempotente?: boolean
  payload?: Record<string, unknown>
}

async function llamar(nombre: string, args: Record<string, unknown>): Promise<{ r: ResultadoEjecucion; data: Datos; error: string | null }> {
  const r = await ejecutarHerramienta(nombre, args, ctx)
  const salida = JSON.parse(r.salida) as { ok: boolean; data?: Datos; error?: string }
  return { r, data: salida.data ?? {}, error: salida.error ?? null }
}

const linea = (texto = "") => console.log(texto)
const titulo = (texto: string) => {
  linea()
  linea(`━━━ ${texto} ${"━".repeat(Math.max(0, 70 - texto.length))}`)
}

type Esperado = { resultado: "creada" | "bloqueada" | "pendiente_confirmacion"; bloqueos?: string[]; confirmaciones?: string[]; retroactiva?: boolean }
const ESPERADO: Record<string, Esperado> = {
  "sol-001": { resultado: "creada", bloqueos: [], confirmaciones: [], retroactiva: false },
  "sol-002": { resultado: "bloqueada", bloqueos: ["RC1"] },
  "sol-003": { resultado: "bloqueada", bloqueos: ["RC2"] },
  "sol-004": { resultado: "pendiente_confirmacion", confirmaciones: ["RC5"] },
  "sol-005": { resultado: "pendiente_confirmacion", confirmaciones: ["RC8"], retroactiva: true },
  "sol-006": { resultado: "pendiente_confirmacion", confirmaciones: ["RC6"] },
}
const verificaciones: Array<{ nombre: string; ok: boolean; detalle: string }> = []
const verificar = (nombre: string, ok: boolean, detalle: string) => verificaciones.push({ nombre, ok, detalle })
const iguales = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((x, i) => x === b[i])

async function procesarCaso(caso: string): Promise<void> {
  titulo(caso)
  const paquete = await llamar("oc_leer_paquete", { caso })
  if (!paquete.r.ok) {
    linea(`  ✗ paquete: ${paquete.error}`)
    return
  }
  linea(`  Paquete     ${paquete.r.resumen}`)

  const validacion = await llamar("oc_validar", { caso })
  if (!validacion.r.ok) {
    linea(`  ✗ validación: ${validacion.error}`)
    return
  }
  const v = validacion.data
  linea(`  apta        ${v.apta ? "sí" : "NO"}`)
  linea(`  retroactiva ${v.retroactiva ? "SÍ" : "no"}`)
  linea(`  bloqueos    ${v.bloqueos?.length ? "" : "—"}`)
  for (const b of v.bloqueos ?? []) linea(`    • ${b.codigo}: ${b.detalle}\n      → ${b.accion_sugerida}`)
  linea(`  confirmar   ${v.confirmaciones?.length ? "" : "—"}`)
  for (const c of v.confirmaciones ?? []) linea(`    • ${c.codigo}: ${c.detalle}`)
  for (const [campo, d] of Object.entries(v.derivados ?? {})) linea(`  derivado    ${campo} = ${d.valor} (${d.motivo})`)

  if (v.apta) {
    const payload = await llamar("oc_construir_payload", { caso })
    linea(`  payload     ${payload.r.resumen} → ${String(payload.data.ruta_trazabilidad ?? "")}`)
    const evidencia = await llamar("oc_generar_evidencia", { caso })
    linea(`  evidencia   ${String(evidencia.data.ruta ?? evidencia.error)} · sha256 ${String(evidencia.data.sha256 ?? "").slice(0, 16)}…`)
  }

  const creada = await llamar("oc_crear", { caso })
  const resultado = creada.r.ok ? "creada" : creada.r.codigo === "NO_APTA" ? "bloqueada" : "pendiente_confirmacion"
  linea(`  resultado   ${creada.r.ok ? `✓ OC ${creada.data.numero_oc}` : `⏸ ${creada.r.codigo}: ${creada.error}`}`)

  const e = ESPERADO[caso]
  if (e) {
    const codigosB = (v.bloqueos ?? []).map((b) => b.codigo)
    const codigosC = (v.confirmaciones ?? []).map((c) => c.codigo)
    verificar(`${caso} resultado`, resultado === e.resultado, `${resultado} (esperado ${e.resultado})`)
    if (e.bloqueos) verificar(`${caso} bloqueos`, iguales(codigosB, e.bloqueos), `[${codigosB}] (esperado [${e.bloqueos}])`)
    if (e.confirmaciones) verificar(`${caso} confirmaciones`, iguales(codigosC, e.confirmaciones), `[${codigosC}] (esperado [${e.confirmaciones}])`)
    if (e.retroactiva !== undefined) verificar(`${caso} retroactiva`, v.retroactiva === e.retroactiva, String(v.retroactiva))
  }
}

async function main(): Promise<void> {
  await rm(rutaSalida(directory), { recursive: true, force: true })
  linea("Demo reto 03 — Órdenes de compra SAP (sin modelo de lenguaje)")
  linea(`Raíz: ${directory}`)

  for (const caso of Object.keys(ESPERADO)) await procesarCaso(caso)

  titulo("Idempotencia: sol-001 por segunda vez")
  const repetida = await llamar("oc_crear", { caso: "sol-001" })
  linea(`  ${repetida.r.resumen}`)
  verificar("sol-001 idempotente", repetida.r.ok && repetida.data.idempotente === true, `idempotente=${String(repetida.data.idempotente)}`)

  titulo("Payload alterado: sol-004 con precio modificado")
  const construido = await llamar("oc_construir_payload", { caso: "sol-004" })
  const alterado = structuredClone(construido.data.payload ?? {}) as { posiciones?: Array<{ precio_unitario: number }> }
  if (alterado.posiciones?.[0]) alterado.posiciones[0].precio_unitario = 265000
  const rechazo = await llamar("oc_crear", { caso: "sol-004", payload: alterado, confirmado: true })
  linea(`  ${rechazo.r.ok ? "✗ se aceptó" : `✓ rechazado (${rechazo.r.codigo}): ${rechazo.error}`}`)
  verificar("sol-004 payload alterado rechazado", rechazo.r.codigo === "PAYLOAD_ALTERADO", String(rechazo.r.codigo))

  titulo("Confirmación explícita: sol-004 (cotización ≠ solicitud)")
  const confirmada = await llamar("oc_crear", { caso: "sol-004", payload: construido.data.payload, confirmado: true })
  linea(`  ${confirmada.r.resumen} · evidencia ${String(confirmada.data.ruta_evidencia ?? "")}`)
  verificar("sol-004 creada tras confirmar", confirmada.r.ok && !confirmada.data.idempotente, String(confirmada.data.numero_oc))

  titulo("Confirmación explícita: sol-005 (retroactiva)")
  const retro = await llamar("oc_crear", { caso: "sol-005", confirmado: true })
  linea(`  ${retro.r.resumen}`)
  verificar("sol-005 creada y marcada retroactiva", retro.r.ok && retro.data.retroactiva === true, String(retro.data.retroactiva))

  titulo("sol-006 sin confirmar: sigue pendiente")
  const pendiente = await llamar("oc_crear", { caso: "sol-006" })
  linea(`  ${pendiente.r.codigo}: no se crea hasta que el usuario confirme el indicador de IVA derivado.`)

  titulo("Errores claros")
  const inexistente = await llamar("oc_leer_paquete", { caso: "sol-999" })
  linea(`  caso inexistente → ${inexistente.error}`)
  const sinCaso = await llamar("oc_validar", {})
  linea(`  argumentos inválidos → ${sinCaso.error}`)
  verificar("errores tipados", !inexistente.r.ok && !sinCaso.r.ok, "ok:false sin excepción")

  titulo("out/control.csv")
  const control = await leerTexto(rutaSalida(directory, "control.csv"))
  if (control.estado === "ok") {
    for (const fila of control.valor.trim().split("\n")) linea(`  ${fila.replace(/,[^,]*$/, "")}`)
  }

  titulo("Verificación contra el PRD")
  for (const v of verificaciones) linea(`  ${v.ok ? "✓" : "✗"} ${v.nombre.padEnd(38)} ${v.detalle}`)
  const fallidas = verificaciones.filter((v) => !v.ok).length
  linea()
  linea(fallidas ? `✗ ${fallidas} verificación(es) fallida(s)` : `✓ ${verificaciones.length}/${verificaciones.length} verificaciones correctas`)
  process.exitCode = fallidas ? 1 : 0
}

await main()
