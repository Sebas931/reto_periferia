import type { z } from "zod"
import type { SapAdapter } from "../sap/adapter.ts"

export type ContextoHerramienta = {
  /** Raíz del proyecto: todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
  /**
   * Casos que el usuario confirmó en su último mensaje (lo calcula el backend, no el modelo).
   * undefined = sin guardia (demo.ts, uso como módulo); [] = nadie confirmó nada.
   */
  casosConfirmados?: readonly string[]
  /** Adaptador SAP; por defecto el simulado sobre out/sap/. */
  sap?: SapAdapter
}

/** Contrato del PRD 6.2: description + args zod + execute que devuelve JSON y nunca lanza. */
export type Herramienta<S extends z.ZodRawShape> = {
  description: string
  args: S
  execute(args: z.infer<z.ZodObject<S>>, ctx: ContextoHerramienta): Promise<string>
}

export const definir = <S extends z.ZodRawShape>(h: Herramienta<S>): Herramienta<S> => h
