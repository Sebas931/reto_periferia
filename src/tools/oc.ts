/**
 * Herramientas del agente de órdenes de compra. Cada export se expone al modelo como oc_<export>.
 * Son la única fuente de valores que el agente puede afirmar: releen los fixtures en cada llamada
 * y no confían en datos que el modelo les devuelva (paquete, derivados, payload).
 */
import { z } from "zod"
import { escribirArchivo, relativa, rutaSalida } from "../dominio/archivos.ts"
import { registrarIntento, type FilaControl } from "../dominio/control.ts"
import { evaluarControles, type Validacion } from "../dominio/controles.ts"
import { contenidoEvidencia, pdfEvidencia, sha256, textoEvidencia } from "../dominio/evidencia.ts"
import { cargarMaestros } from "../dominio/maestros.ts"
import { listarCasos, leerPaquete } from "../dominio/paquete.ts"
import { construirOrden, diferenciasOrden, mismoContenido, type OrdenConstruida } from "../dominio/payload.ts"
import { exito, fallo, mensajeDeError, type Resultado } from "../dominio/resultado.ts"
import type { Paquete } from "../dominio/tipos.ts"
import { SapMock } from "../sap/mock.ts"
import { definir, type ContextoHerramienta } from "./contrato.ts"

const casoArg = z
  .string()
  .min(1)
  .describe('Carpeta del caso en fixtures/reto-03/solicitudes/, ej. "sol-004" (también acepta "SOL-2026-004" o "4")')

const json = (r: Resultado<unknown>): string => JSON.stringify(r)

/** Garantiza el contrato "nunca lanza": cualquier excepción se convierte en { ok: false }. */
async function protegido(caso: string | undefined, tarea: () => Promise<Resultado<unknown>>): Promise<string> {
  try {
    return json(await tarea())
  } catch (e) {
    return json(fallo(`error interno: ${mensajeDeError(e)}`, "ERROR_INTERNO", caso))
  }
}

const sapDe = (ctx: ContextoHerramienta) => ctx.sap ?? new SapMock(ctx.directory)

type Evaluacion = { paquete: Paquete; validacion: Validacion }

async function evaluar(ctx: ContextoHerramienta, caso: string): Promise<Resultado<Evaluacion>> {
  const paquete = await leerPaquete(ctx.directory, caso)
  if (!paquete.ok) return paquete
  const maestros = await cargarMaestros(ctx.directory)
  if (!maestros.ok) return fallo(maestros.error, "ERROR_INTERNO", paquete.data.caso)
  return exito({ paquete: paquete.data, validacion: evaluarControles(paquete.data, maestros.maestros) })
}

function construir(ev: Evaluacion, confirmadoPor: string | null): Resultado<OrdenConstruida> {
  const r = construirOrden(ev.paquete, ev.validacion, confirmadoPor)
  return r.ok ? exito(r.valor) : fallo(r.error, "NO_APTA", ev.paquete.caso)
}

/** Si el modelo envía datos propios, se informa la diferencia pero siempre se usa la fuente. */
function advertirSiDifiere(nombre: string, recibido: unknown, fuente: unknown): string[] {
  if (recibido === undefined || recibido === null || mismoContenido(recibido, fuente)) return []
  return [`El ${nombre} recibido difiere de la fuente; se ignoró y se usó el releído de los archivos.`]
}

/** Del paquete solo se compara la solicitud: es lo que el modelo podría "corregir". */
const solicitudDe = (p: unknown): unknown =>
  p !== null && typeof p === "object" && "solicitud" in p ? (p as { solicitud: unknown }).solicitud : p

const listaCodigos = (v: Validacion) => ({
  bloqueos: v.bloqueos.map((b) => b.codigo),
  confirmaciones: v.confirmaciones.map((c) => c.codigo),
})

// ── oc_listar_solicitudes ────────────────────────────────────────────────

export const listar_solicitudes = definir({
  description: "Lista las solicitudes de compra disponibles con su id, proveedor, valor y si ya tienen OC creada.",
  args: {},
  async execute(_args, ctx) {
    return protegido(undefined, async () => {
      const sap = sapDe(ctx)
      const filas = []
      for (const caso of await listarCasos(ctx.directory)) {
        const p = await leerPaquete(ctx.directory, caso)
        if (!p.ok) {
          filas.push({ caso, error: p.error })
          continue
        }
        const s = p.data.solicitud
        const oc = await sap.buscarOrdenPorReferencia(s.solicitud_id)
        filas.push({
          caso,
          solicitud_id: s.solicitud_id,
          descripcion: s.descripcion,
          proveedor: s.proveedor_nombre,
          valor_total: s.valor_total,
          moneda: s.moneda,
          numero_oc: oc?.numero_oc ?? null,
        })
      }
      return exito({ solicitudes: filas, resumen: `${filas.length} solicitudes` })
    })
  },
})

// ── oc_leer_paquete ──────────────────────────────────────────────────────

export const leer_paquete = definir({
  description: "Lee y normaliza el paquete de un caso: correo, solicitud, cotización, aprobación y factura (si existe).",
  args: { caso: casoArg },
  async execute({ caso }, ctx) {
    return protegido(caso, async () => {
      const p = await leerPaquete(ctx.directory, caso)
      if (!p.ok) return p
      const { solicitud, cotizacion, aprobacion, factura, faltantes } = p.data
      const resumen = [
        `${solicitud.solicitud_id}: ${solicitud.proveedor_nombre}, ${solicitud.moneda} ${solicitud.valor_total}`,
        cotizacion ? `cotización ${cotizacion.numero ?? "s/n"} por ${cotizacion.total}` : "sin cotización",
        aprobacion ? `aprobación de ${aprobacion.de}${aprobacion.aprobado ? "" : " (sin 'Aprobado')"}` : "sin aprobación",
        factura ? `factura ${factura.numero} del ${factura.fecha}` : null,
        faltantes.length ? `faltan: ${faltantes.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
      return exito({ ...p.data, resumen })
    })
  },
})

// ── oc_validar ───────────────────────────────────────────────────────────

export const validar = definir({
  description:
    "Aplica los controles RC1–RC10 al caso y devuelve apta, bloqueos, confirmaciones, valores derivados de maestros y si es retroactiva.",
  args: {
    caso: casoArg,
    paquete: z.unknown().optional().describe("Opcional. El paquete siempre se relee de la fuente; si se envía y difiere, se advierte."),
  },
  async execute({ caso, paquete }, ctx) {
    return protegido(caso, async () => {
      const ev = await evaluar(ctx, caso)
      if (!ev.ok) return ev
      const v = ev.data.validacion
      const existente = await sapDe(ctx).buscarOrdenPorReferencia(v.solicitud_id)
      const { bloqueos, confirmaciones } = listaCodigos(v)
      const resumen = v.apta
        ? `APTA${confirmaciones.length ? ` con confirmación pendiente (${confirmaciones.join(", ")})` : ""}${v.retroactiva ? " · RETROACTIVA" : ""}`
        : `NO APTA: ${bloqueos.join(", ")}`
      return exito({
        ...v,
        requiere_confirmacion: v.apta && v.confirmaciones.length > 0,
        oc_existente: existente?.numero_oc ?? null,
        advertencias: [...v.advertencias, ...advertirSiDifiere("paquete", solicitudDe(paquete), ev.data.paquete.solicitud)],
        resumen,
      })
    })
  },
})

// ── oc_construir_payload ─────────────────────────────────────────────────

export const construir_payload = definir({
  description:
    "Construye la OC exactamente como quedaría en SAP (validada con zod) y guarda su trazabilidad campo por campo; solo para casos aptos.",
  args: {
    caso: casoArg,
    paquete: z.unknown().optional().describe("Opcional. Se relee de la fuente."),
    derivados: z.unknown().optional().describe("Opcional. Se recalculan desde los maestros."),
  },
  async execute({ caso, paquete, derivados }, ctx) {
    return protegido(caso, async () => {
      const ev = await evaluar(ctx, caso)
      if (!ev.ok) return ev
      const v = ev.data.validacion
      const construida = construir(ev.data, null)
      if (!construida.ok) return construida
      const { orden, trazabilidad } = construida.data
      const carpeta = rutaSalida(ctx.directory, ev.data.paquete.caso)
      await escribirArchivo(`${carpeta}/payload.json`, JSON.stringify(orden, null, 2))
      await escribirArchivo(`${carpeta}/trazabilidad.json`, JSON.stringify(trazabilidad, null, 2))
      return exito({
        caso: ev.data.paquete.caso,
        payload: orden,
        trazabilidad,
        ruta_payload: relativa(ctx.directory, `${carpeta}/payload.json`),
        ruta_trazabilidad: relativa(ctx.directory, `${carpeta}/trazabilidad.json`),
        confirmaciones_pendientes: v.confirmaciones,
        requiere_confirmacion: v.confirmaciones.length > 0,
        retroactiva: v.retroactiva,
        advertencias: [
          ...advertirSiDifiere("paquete", solicitudDe(paquete), ev.data.paquete.solicitud),
          ...advertirSiDifiere("objeto de derivados", derivados, v.derivados),
        ],
        resumen: `OC lista para ${orden.proveedor.nombre}: ${orden.posiciones.length} posición(es), ${orden.moneda} ${ev.data.paquete.solicitud.valor_total}`,
      })
    })
  },
})

// ── oc_generar_evidencia ─────────────────────────────────────────────────

async function escribirEvidencia(ctx: ContextoHerramienta, paquete: Paquete) {
  const contenido = contenidoEvidencia(paquete)
  if (!contenido || !paquete.aprobacion) return fallo("no hay correo de aprobación del cual generar evidencia", "PAQUETE_INCOMPLETO", paquete.caso)
  const hash = sha256(contenido)
  const carpeta = rutaSalida(ctx.directory, paquete.caso)
  await escribirArchivo(`${carpeta}/aprobacion.txt`, textoEvidencia(contenido, hash))
  await escribirArchivo(`${carpeta}/aprobacion.pdf`, await pdfEvidencia(contenido, hash, paquete.aprobacion.fecha))
  return exito({
    caso: paquete.caso,
    ruta: relativa(ctx.directory, `${carpeta}/aprobacion.txt`),
    ruta_pdf: relativa(ctx.directory, `${carpeta}/aprobacion.pdf`),
    sha256: hash,
    resumen: `evidencia generada (sha256 ${hash.slice(0, 12)}…)`,
  })
}

export const generar_evidencia = definir({
  description: "Genera la evidencia de aprobación del líder (aprobacion.txt y aprobacion.pdf con sha256) en out/<caso>/.",
  args: { caso: casoArg },
  async execute({ caso }, ctx) {
    return protegido(caso, async () => {
      const p = await leerPaquete(ctx.directory, caso)
      if (!p.ok) return p
      return escribirEvidencia(ctx, p.data)
    })
  },
})

// ── oc_crear ─────────────────────────────────────────────────────────────

export const crear = definir({
  description:
    "Crea la OC en SAP (simulado). Solo si el caso es apto; si tiene confirmaciones exige confirmado=true tras la confirmación explícita del usuario. Idempotente por solicitud_id.",
  args: {
    caso: casoArg,
    payload: z.unknown().optional().describe("Opcional. Si se envía debe ser idéntico al de oc_construir_payload; si difiere se rechaza."),
    confirmado: z
      .boolean()
      .optional()
      .describe("true solo si el usuario confirmó explícitamente las excepciones de este caso en su último mensaje"),
  },
  async execute({ caso, payload, confirmado }, ctx) {
    return protegido(caso, async () => {
      const ev = await evaluar(ctx, caso)
      if (!ev.ok) return ev
      const { paquete, validacion: v } = ev.data
      const sap = sapDe(ctx)
      const codigos = listaCodigos(v)
      const intento = (resultado: FilaControl["resultado"], numero_oc: string | null = null) =>
        registrarIntento(ctx.directory, { solicitud_id: v.solicitud_id, resultado, numero_oc, retroactiva: v.retroactiva, ...codigos })

      // 1. Idempotencia: si ya existe, se devuelve el mismo número sin crear otra OC.
      const existente = await sap.buscarOrdenPorReferencia(v.solicitud_id)
      if (existente) {
        await intento("existente", existente.numero_oc)
        return exito({
          caso: paquete.caso,
          numero_oc: existente.numero_oc,
          idempotente: true,
          retroactiva: v.retroactiva,
          resumen: `La OC ${existente.numero_oc} ya existía para ${v.solicitud_id}; no se creó otra.`,
        })
      }

      // 2. Bloqueos: nunca se crea.
      if (!v.apta) {
        await intento("bloqueada")
        return fallo(
          `No se puede crear la OC de ${v.solicitud_id}: ${v.bloqueos.map((b) => `${b.codigo} — ${b.detalle} Acción: ${b.accion_sugerida}`).join(" | ")}`,
          "NO_APTA",
          paquete.caso,
        )
      }

      // 3. Confirmaciones: requieren confirmado=true, y en el chat además que el usuario lo haya dicho.
      if (v.confirmaciones.length) {
        if (!confirmado) {
          await intento("pendiente_confirmacion")
          return fallo(
            `requiere confirmación explícita del usuario para: ${v.confirmaciones.map((c) => `${c.codigo} (${c.detalle})`).join(" | ")}`,
            "REQUIERE_CONFIRMACION",
            paquete.caso,
          )
        }
        if (ctx.casosConfirmados && !ctx.casosConfirmados.includes(paquete.caso)) {
          await intento("pendiente_confirmacion")
          return fallo(
            `confirmado=true no es válido: el usuario no confirmó ${paquete.caso} en su último mensaje. Presenta las excepciones y pregúntale.`,
            "CONFIRMACION_NO_HUMANA",
            paquete.caso,
          )
        }
      }

      const confirmadoPor = v.confirmaciones.length ? `analista (sesión ${ctx.sessionId})` : null
      const construida = construir(ev.data, confirmadoPor)
      if (!construida.ok) {
        await intento("error")
        return construida
      }
      const { orden } = construida.data

      // 4. El modelo no puede alterar el payload validado.
      if (payload !== undefined && payload !== null) {
        const diferencias = diferenciasOrden(orden, payload)
        if (diferencias.length) {
          await intento("error")
          return fallo(
            `el payload recibido no coincide con el validado (campos: ${diferencias.join(", ")}). Llama oc_crear sin payload o con el de oc_construir_payload.`,
            "PAYLOAD_ALTERADO",
            paquete.caso,
          )
        }
      }

      const evidencia = await escribirEvidencia(ctx, paquete)
      if (!evidencia.ok) {
        await intento("error")
        return evidencia
      }

      let creada: { numero_oc: string; fecha: string }
      try {
        creada = await sap.crearOrden(orden)
      } catch (e) {
        await intento("error")
        return fallo(`SAP rechazó la orden: ${mensajeDeError(e)}`, "ERROR_SAP", paquete.caso)
      }
      const carpeta = rutaSalida(ctx.directory, paquete.caso)
      await escribirArchivo(`${carpeta}/oc.json`, JSON.stringify({ ...creada, orden }, null, 2))
      await intento("creada", creada.numero_oc)

      return exito({
        caso: paquete.caso,
        numero_oc: creada.numero_oc,
        fecha: creada.fecha,
        idempotente: false,
        retroactiva: v.retroactiva,
        excepciones: orden.excepciones,
        ruta_evidencia: evidencia.data.ruta,
        ruta_evidencia_pdf: evidencia.data.ruta_pdf,
        resumen: `OC ${creada.numero_oc} creada para ${v.solicitud_id}${v.retroactiva ? " (marcada RETROACTIVA)" : ""}`,
      })
    })
  },
})
