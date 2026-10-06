import type { AdaptadorLlm, BloqueResultado, MensajeLlm, Uso } from "../llm/adapter.ts"
import { ErrorLlm } from "../llm/adapter.ts"
import type { SapAdapter } from "../sap/adapter.ts"
import { definicionesHerramientas, ejecutarHerramienta, type ResultadoEjecucion } from "../tools/registro.ts"
import { casosConfirmados, notaConfirmacion } from "./confirmacion.ts"
import type { EntradaTranscripcion, Sesion } from "./sesiones.ts"

export type DependenciasCiclo = {
  llm: AdaptadorLlm
  system: string
  directorio: string
  maxIteraciones: number
  maxTokensSesion: number
  /** Reserva tokens del presupuesto global; devuelve false si ya se agotó. */
  presupuestoGlobal: { disponible(): boolean; consumir(uso: Uso): void }
  sap?: SapAdapter
}

export type LlamadaVisible = { id: string; nombre: string; argumentos: unknown; ok: boolean; resumen: string; resultado: string }

export type EventoTurno =
  | { tipo: "pensando"; iteracion: number }
  | { tipo: "herramienta_inicio"; id: string; nombre: string; argumentos: unknown }
  | ({ tipo: "herramienta_fin" } & LlamadaVisible)
  | { tipo: "texto"; texto: string }

export type ResultadoTurno = {
  reply: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
  casosPendientes: string[]
  iteraciones: number
  uso: Uso
  error: string | null
}

const ahora = () => new Date().toISOString()
const totalTokens = (u: Uso) => u.entrada + u.salida + u.cacheLectura + u.cacheEscritura
const sumar = (a: Uso, b: Uso): Uso => ({
  entrada: a.entrada + b.entrada,
  salida: a.salida + b.salida,
  cacheLectura: a.cacheLectura + b.cacheLectura,
  cacheEscritura: a.cacheEscritura + b.cacheEscritura,
})

/** Resultado visible en el chat: se recorta para no inundar la interfaz (el modelo recibe el completo). */
const recortar = (texto: string, max = 4000) => (texto.length > max ? `${texto.slice(0, max)}…` : texto)

/**
 * Un turno del agente: mensaje del usuario → (modelo → herramientas)* → respuesta.
 * Nunca lanza: los errores del proveedor o de herramientas se devuelven en lenguaje claro (CA5).
 */
export async function ejecutarTurno(
  sesion: Sesion,
  textoUsuario: string,
  deps: DependenciasCiclo,
  emitir: (e: EventoTurno) => void = () => {},
): Promise<ResultadoTurno> {
  const confirmados = casosConfirmados(textoUsuario, sesion.pendientes)
  const nota = notaConfirmacion(sesion.pendientes, confirmados)
  sesion.transcripcion.push({ tipo: "usuario", texto: textoUsuario, ts: ahora() })
  sesion.mensajes.push({
    rol: "usuario",
    bloques: [{ tipo: "texto", texto: textoUsuario }, ...(nota ? [{ tipo: "texto" as const, texto: nota }] : [])],
  })

  const herramientas = definicionesHerramientas()
  const llamadas: LlamadaVisible[] = []
  const ejecuciones: ResultadoEjecucion[] = []
  const textos: string[] = []
  let usoTurno: Uso = { entrada: 0, salida: 0, cacheLectura: 0, cacheEscritura: 0 }
  let error: string | null = null
  let iteracion = 0

  try {
    while (true) {
      if (totalTokens(sesion.uso) >= deps.maxTokensSesion) {
        error = "Esta sesión alcanzó su tope de tokens. Abre una sesión nueva para continuar."
        break
      }
      if (!deps.presupuestoGlobal.disponible()) {
        error = "Se alcanzó el tope diario de uso del modelo en este servidor. Intenta mañana o usa demo.ts."
        break
      }
      const permitirHerramientas = iteracion < deps.maxIteraciones
      emitir({ tipo: "pensando", iteracion })
      const respuesta = await deps.llm.enviar(sesion.mensajes, herramientas, { system: deps.system, permitirHerramientas })
      iteracion++
      usoTurno = sumar(usoTurno, respuesta.uso)
      sesion.uso = sumar(sesion.uso, respuesta.uso)
      deps.presupuestoGlobal.consumir(respuesta.uso)
      if (respuesta.mensaje.bloques.length) sesion.mensajes.push(respuesta.mensaje)

      for (const b of respuesta.mensaje.bloques) {
        if (b.tipo === "texto") {
          textos.push(b.texto)
          emitir({ tipo: "texto", texto: b.texto })
        }
      }

      if (respuesta.motivoFin === "rechazo") {
        error = `El modelo declinó esta solicitud${respuesta.detalle ? ` (${respuesta.detalle})` : ""}. Reformúlala.`
        cerrarLlamadasPendientes(sesion, "El turno terminó antes de ejecutar esta herramienta.")
        break
      }
      const pedidas = respuesta.mensaje.bloques.filter((b) => b.tipo === "llamada")
      if (!pedidas.length || !permitirHerramientas) {
        if (respuesta.motivoFin === "tope_tokens") textos.push("(La respuesta se cortó por longitud.)")
        cerrarLlamadasPendientes(sesion, "El turno terminó antes de ejecutar esta herramienta.")
        break
      }

      const resultados: BloqueResultado[] = []
      for (const llamada of pedidas) {
        emitir({ tipo: "herramienta_inicio", id: llamada.id, nombre: llamada.nombre, argumentos: llamada.entrada })
        const r = await ejecutarHerramienta(llamada.nombre, llamada.entrada, {
          directory: deps.directorio,
          sessionId: sesion.id,
          casosConfirmados: confirmados,
          ...(deps.sap ? { sap: deps.sap } : {}),
        })
        ejecuciones.push(r)
        const visible: LlamadaVisible = {
          id: llamada.id,
          nombre: r.nombre,
          argumentos: r.argumentos,
          ok: r.ok,
          resumen: r.resumen,
          resultado: recortar(r.salida),
        }
        llamadas.push(visible)
        sesion.transcripcion.push({ tipo: "herramienta", ts: ahora(), ...visible })
        emitir({ tipo: "herramienta_fin", ...visible })
        resultados.push({ tipo: "resultado", idLlamada: llamada.id, contenido: r.salida, esError: !r.ok })
      }

      const mensajeResultados: Extract<MensajeLlm, { rol: "usuario" }> = { rol: "usuario", bloques: resultados }
      if (iteracion >= deps.maxIteraciones) {
        mensajeResultados.bloques.push({
          tipo: "texto",
          texto: `[Nota del sistema] Se alcanzó el tope de ${deps.maxIteraciones} iteraciones de este turno. Responde ya, sin llamar herramientas: qué quedó hecho y qué falta.`,
        })
      }
      sesion.mensajes.push(mensajeResultados)
    }
  } catch (e) {
    error = e instanceof ErrorLlm ? e.message : `Error inesperado en el agente: ${e instanceof Error ? e.message : String(e)}`
    cerrarLlamadasPendientes(sesion, "No se ejecutó por un error del proveedor.")
  }

  const pendientes = casosPendientesDe(ejecuciones)
  sesion.pendientes = pendientes
  const reply = textos.join("\n\n").trim()
  const entrada: EntradaTranscripcion = {
    tipo: "asistente",
    texto: reply,
    ts: ahora(),
    necesitaConfirmacion: pendientes.length > 0,
    casosPendientes: pendientes,
  }
  if (reply) sesion.transcripcion.push(entrada)
  if (error) sesion.transcripcion.push({ tipo: "error", texto: error, ts: ahora() })

  return {
    reply,
    toolCalls: llamadas,
    needsConfirmation: pendientes.length > 0,
    casosPendientes: pendientes,
    iteraciones: iteracion,
    uso: usoTurno,
    error,
  }
}

/**
 * Casos que en este turno quedaron esperando confirmación: alguna herramienta la pidió
 * y después no se creó la OC. Solo cuenta este turno (CA3: la confirmación vale para el siguiente mensaje).
 */
function casosPendientesDe(ejecuciones: ResultadoEjecucion[]): string[] {
  const estado = new Map<string, boolean>()
  for (const r of ejecuciones) {
    if (!r.caso) continue
    const caso = r.caso.toLowerCase()
    if (r.ocCreada) estado.set(caso, false)
    else if (r.pideConfirmacion) estado.set(caso, true)
    else if (r.ok && r.nombre === "oc_validar") estado.set(caso, false)
  }
  return [...estado].filter(([, pendiente]) => pendiente).map(([caso]) => caso).sort()
}

/** Si el turno se corta con llamadas sin respuesta, se responden como error para que el historial siga siendo válido. */
function cerrarLlamadasPendientes(sesion: Sesion, motivo: string): void {
  const ultimo = sesion.mensajes.at(-1)
  if (ultimo?.rol !== "asistente") return
  const llamadas = ultimo.bloques.filter((b) => b.tipo === "llamada")
  if (!llamadas.length) return
  sesion.mensajes.push({
    rol: "usuario",
    bloques: llamadas.map((l) => ({
      tipo: "resultado" as const,
      idLlamada: l.id,
      contenido: JSON.stringify({ ok: false, error: motivo }),
      esError: true,
    })),
  })
}
