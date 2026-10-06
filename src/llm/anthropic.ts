import Anthropic from "@anthropic-ai/sdk"
import type { DefinicionHerramienta } from "../tools/registro.ts"
import { ErrorLlm, type AdaptadorLlm, type MensajeLlm, type MotivoFin, type OpcionesEnvio, type RespuestaLlm } from "./adapter.ts"

type Esfuerzo = "low" | "medium" | "high" | "xhigh" | "max"

export type ConfigAnthropic = {
  modelo: string
  esfuerzo: Esfuerzo
  maxTokens: number
  timeoutMs: number
}

const PROVEEDOR = "anthropic"

/** Implementación de AdaptadorLlm sobre la Messages API de Claude (ciclo manual de herramientas). */
export class AdaptadorAnthropic implements AdaptadorLlm {
  readonly proveedor = PROVEEDOR
  readonly modelo: string
  private readonly cliente: Anthropic

  constructor(private readonly config: ConfigAnthropic) {
    this.modelo = config.modelo
    // La clave se lee de ANTHROPIC_API_KEY dentro del SDK; nunca pasa por este código ni por logs.
    this.cliente = new Anthropic({ timeout: config.timeoutMs, maxRetries: 2 })
  }

  async enviar(mensajes: MensajeLlm[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<RespuestaLlm> {
    let respuesta: Anthropic.Beta.BetaMessage
    try {
      respuesta = await this.cliente.beta.messages.create(
        {
          model: this.config.modelo,
          max_tokens: this.config.maxTokens,
          system: opciones.system,
          messages: mensajes.map(aMensajeAnthropic),
          tools: herramientas.map((h) => ({
            name: h.nombre,
            description: h.descripcion,
            input_schema: h.esquema as Anthropic.Beta.BetaTool.InputSchema,
          })),
          tool_choice: { type: opciones.permitirHerramientas ? "auto" : "none" },
          output_config: { effort: this.config.esfuerzo },
          // Cachea el prefijo estable (herramientas + system + historial) entre iteraciones del ciclo.
          cache_control: { type: "ephemeral" },
          // Si un clasificador de seguridad rechaza la petición, la API reintenta con el modelo de respaldo.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal: opciones.signal },
      )
    } catch (e) {
      throw traducirError(e)
    }

    const bloques: Extract<MensajeLlm, { rol: "asistente" }>["bloques"] = []
    for (const b of respuesta.content) {
      if (b.type === "text" && b.text.trim()) bloques.push({ tipo: "texto", texto: b.text })
      if (b.type === "tool_use") bloques.push({ tipo: "llamada", id: b.id, nombre: b.name, entrada: b.input })
    }

    return {
      mensaje: { rol: "asistente", bloques, nativo: { proveedor: PROVEEDOR, contenido: respuesta.content } },
      motivoFin: motivo(respuesta.stop_reason),
      uso: {
        entrada: respuesta.usage.input_tokens,
        salida: respuesta.usage.output_tokens,
        cacheLectura: respuesta.usage.cache_read_input_tokens ?? 0,
        cacheEscritura: respuesta.usage.cache_creation_input_tokens ?? 0,
      },
      modelo: respuesta.model,
      ...(respuesta.stop_reason === "refusal" && respuesta.stop_details
        ? { detalle: respuesta.stop_details.explanation ?? respuesta.stop_details.category ?? undefined }
        : {}),
    }
  }
}

function aMensajeAnthropic(m: MensajeLlm): Anthropic.Beta.BetaMessageParam {
  if (m.rol === "asistente") {
    // Se reenvía el contenido original (incluye bloques de razonamiento) para no romper la continuidad.
    if (m.nativo?.proveedor === PROVEEDOR) {
      return { role: "assistant", content: m.nativo.contenido as Anthropic.Beta.BetaContentBlockParam[] }
    }
    return {
      role: "assistant",
      content: m.bloques.map((b) =>
        b.tipo === "texto"
          ? { type: "text" as const, text: b.texto }
          : { type: "tool_use" as const, id: b.id, name: b.nombre, input: b.entrada as Record<string, unknown> },
      ),
    }
  }
  return {
    role: "user",
    content: m.bloques.map((b) =>
      b.tipo === "texto"
        ? { type: "text" as const, text: b.texto }
        : { type: "tool_result" as const, tool_use_id: b.idLlamada, content: b.contenido, is_error: b.esError },
    ),
  }
}

function motivo(stop: Anthropic.Beta.BetaStopReason | null): MotivoFin {
  switch (stop) {
    case "end_turn":
    case "stop_sequence":
      return "fin"
    case "tool_use":
      return "herramientas"
    case "max_tokens":
      return "tope_tokens"
    case "refusal":
      return "rechazo"
    default:
      return "otro"
  }
}

function traducirError(e: unknown): ErrorLlm {
  if (e instanceof Anthropic.APIUserAbortError) return new ErrorLlm("La consulta al modelo se canceló.", false)
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new ErrorLlm("El modelo tardó demasiado en responder (timeout). Intenta de nuevo en un momento.", true)
  }
  if (e instanceof Anthropic.AuthenticationError) {
    return new ErrorLlm("El backend no tiene una clave válida del proveedor de IA. Revisa ANTHROPIC_API_KEY en el servidor.", false)
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new ErrorLlm("El proveedor de IA está limitando las solicitudes. Espera unos segundos y reintenta.", true)
  }
  if (e instanceof Anthropic.BadRequestError) return new ErrorLlm(`El proveedor rechazó la solicitud: ${e.message}`, false)
  if (e instanceof Anthropic.APIConnectionError) {
    return new ErrorLlm("No hay conexión con el proveedor de IA. Revisa la red del servidor.", true)
  }
  if (e instanceof Anthropic.APIError) {
    return new ErrorLlm(`El proveedor de IA respondió con un error (${String(e.status ?? "sin estado")}). Intenta de nuevo.`, true)
  }
  return new ErrorLlm(`Error inesperado al consultar el modelo: ${e instanceof Error ? e.message : String(e)}`, false)
}
