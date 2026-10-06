/**
 * Contrato de salida de toda herramienta: nunca se lanza una excepción hacia el agente.
 * `codigo` permite al backend reaccionar sin interpretar texto (por ejemplo, REQUIERE_CONFIRMACION).
 */
export type Exito<T> = { ok: true; data: T }
export type Fallo = { ok: false; error: string; codigo?: CodigoError; caso?: string }
export type Resultado<T> = Exito<T> | Fallo

export type CodigoError =
  | "CASO_INVALIDO"
  | "PAQUETE_INCOMPLETO"
  | "DATOS_INVALIDOS"
  | "NO_APTA"
  | "REQUIERE_CONFIRMACION"
  | "CONFIRMACION_NO_HUMANA"
  | "PAYLOAD_ALTERADO"
  | "ERROR_SAP"
  | "ERROR_INTERNO"

export const exito = <T>(data: T): Exito<T> => ({ ok: true, data })

export const fallo = (error: string, codigo?: CodigoError, caso?: string): Fallo => ({
  ok: false,
  error,
  ...(codigo ? { codigo } : {}),
  ...(caso ? { caso } : {}),
})

export function mensajeDeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
