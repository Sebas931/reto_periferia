import { readFile } from "node:fs/promises"
import { join } from "node:path"

export const RUTA_PROMPT = "agent/prompt.md"
export const RUTA_CONOCIMIENTO = "src/knowledge/ordenes-compra.md"

/**
 * System prompt = comportamiento (agent/prompt.md) + conocimiento del proceso (src/knowledge/).
 * Es estable entre turnos (sin fechas ni ids) para que el proveedor pueda cachearlo.
 */
export async function cargarSystemPrompt(directorio: string): Promise<string> {
  const [comportamiento, conocimiento] = await Promise.all([
    readFile(join(directorio, RUTA_PROMPT), "utf8"),
    readFile(join(directorio, RUTA_CONOCIMIENTO), "utf8"),
  ])
  return `${comportamiento.trim()}\n\n---\n\n${conocimiento.trim()}\n`
}
