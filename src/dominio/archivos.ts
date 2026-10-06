import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { RUTAS } from "./reglas.ts"

export type Lectura<T> = { estado: "ok"; valor: T } | { estado: "ausente" } | { estado: "invalido"; error: string }

export async function existe(ruta: string): Promise<boolean> {
  try {
    await stat(ruta)
    return true
  } catch {
    return false
  }
}

export async function leerTexto(ruta: string): Promise<Lectura<string>> {
  try {
    return { estado: "ok", valor: await readFile(ruta, "utf8") }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { estado: "ausente" }
    return { estado: "invalido", error: `no se pudo leer: ${(e as Error).message}` }
  }
}

export async function leerJson(ruta: string): Promise<Lectura<unknown>> {
  const texto = await leerTexto(ruta)
  if (texto.estado !== "ok") return texto
  try {
    return { estado: "ok", valor: JSON.parse(texto.valor) as unknown }
  } catch (e) {
    return { estado: "invalido", error: `JSON malformado (${(e as Error).message})` }
  }
}

export async function escribirArchivo(ruta: string, contenido: string | Uint8Array): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true })
  await writeFile(ruta, contenido)
}

export async function agregarLinea(ruta: string, linea: string): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true })
  await appendFile(ruta, `${linea}\n`, "utf8")
}

export async function listarDirectorios(ruta: string): Promise<string[]> {
  try {
    const entradas = await readdir(ruta, { withFileTypes: true })
    return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

export const rutaSalida = (directorio: string, ...partes: string[]): string => join(directorio, RUTAS.salida, ...partes)

/** Ruta relativa a la raíz del proyecto, con '/' (se muestra al usuario y se guarda en logs). */
export const relativa = (directorio: string, ruta: string): string =>
  ruta.slice(directorio.length).replace(/\\/g, "/").replace(/^\//, "")
