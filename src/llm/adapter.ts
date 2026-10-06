import type { DefinicionHerramienta } from "../tools/registro.ts"

/**
 * Interfaz propia del proveedor de lenguaje. El ciclo del agente solo conoce estos tipos:
 * cambiar de Anthropic a otro proveedor es escribir otra implementación de AdaptadorLlm.
 */

export type BloqueTexto = { tipo: "texto"; texto: string }
export type BloqueLlamada = { tipo: "llamada"; id: string; nombre: string; entrada: unknown }
export type BloqueResultado = { tipo: "resultado"; idLlamada: string; contenido: string; esError: boolean }

export type MensajeLlm =
  | { rol: "usuario"; bloques: Array<BloqueTexto | BloqueResultado> }
  /**
   * `nativo` guarda el contenido tal como lo devolvió el proveedor (por ejemplo bloques de
   * razonamiento firmados) para reenviarlo sin modificar en la siguiente iteración.
   */
  | { rol: "asistente"; bloques: Array<BloqueTexto | BloqueLlamada>; nativo?: { proveedor: string; contenido: unknown } }

export type MotivoFin = "fin" | "herramientas" | "tope_tokens" | "rechazo" | "otro"

export type Uso = { entrada: number; salida: number; cacheLectura: number; cacheEscritura: number }

export type RespuestaLlm = {
  mensaje: Extract<MensajeLlm, { rol: "asistente" }>
  motivoFin: MotivoFin
  uso: Uso
  modelo: string
  detalle?: string
}

export type OpcionesEnvio = {
  system: string
  /** false = el modelo debe responder en texto (se usa al alcanzar el tope de iteraciones). */
  permitirHerramientas: boolean
  signal?: AbortSignal
}

export interface AdaptadorLlm {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: MensajeLlm[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<RespuestaLlm>
}

/** Error del proveedor ya traducido a lenguaje claro para el chat (CA5). */
export class ErrorLlm extends Error {
  constructor(
    message: string,
    readonly reintentable: boolean,
  ) {
    super(message)
    this.name = "ErrorLlm"
  }
}
