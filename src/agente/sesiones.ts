import { randomUUID } from "node:crypto"
import { escribirArchivo, leerJson, rutaSalida } from "../dominio/archivos.ts"
import type { MensajeLlm, Uso } from "../llm/adapter.ts"

export type EntradaTranscripcion =
  | { tipo: "usuario"; texto: string; ts: string }
  | { tipo: "asistente"; texto: string; ts: string; necesitaConfirmacion: boolean; casosPendientes: string[] }
  | { tipo: "herramienta"; id: string; nombre: string; argumentos: unknown; ok: boolean; resumen: string; resultado: string; ts: string }
  | { tipo: "error"; texto: string; ts: string }

export type Sesion = {
  id: string
  creada: string
  /** Historial en el formato neutro del adaptador (lo que se envía al modelo). */
  mensajes: MensajeLlm[]
  /** Lo que ve la usuaria en el chat, incluidas las llamadas a herramientas. */
  transcripcion: EntradaTranscripcion[]
  /** Casos que pidieron confirmación en el último turno del agente. */
  pendientes: string[]
  uso: Uso
  ocupada: boolean
}

const ID_VALIDO = /^[A-Za-z0-9_-]{8,64}$/

export const idValido = (id: string): boolean => ID_VALIDO.test(id)

/** Sesiones en memoria, con copia en out/sesiones/<id>.json para auditoría y para sobrevivir reinicios. */
export class AlmacenSesiones {
  private readonly sesiones = new Map<string, Sesion>()

  constructor(
    private readonly directorio: string,
    private readonly maximo: number,
  ) {}

  private ruta(id: string): string {
    return rutaSalida(this.directorio, "sesiones", `${id}.json`)
  }

  async obtener(id: string): Promise<Sesion | null> {
    if (!idValido(id)) return null
    const enMemoria = this.sesiones.get(id)
    if (enMemoria) return enMemoria
    const disco = await leerJson(this.ruta(id))
    if (disco.estado !== "ok") return null
    const sesion = { ...(disco.valor as Sesion), ocupada: false }
    this.sesiones.set(id, sesion)
    return sesion
  }

  async obtenerOCrear(id: string | undefined): Promise<Sesion> {
    if (id) {
      const existente = await this.obtener(id)
      if (existente) return existente
    }
    if (this.sesiones.size >= this.maximo) this.descartarMasAntigua()
    const sesion: Sesion = {
      id: id && idValido(id) ? id : randomUUID(),
      creada: new Date().toISOString(),
      mensajes: [],
      transcripcion: [],
      pendientes: [],
      uso: { entrada: 0, salida: 0, cacheLectura: 0, cacheEscritura: 0 },
      ocupada: false,
    }
    this.sesiones.set(sesion.id, sesion)
    return sesion
  }

  async guardar(sesion: Sesion): Promise<void> {
    try {
      await escribirArchivo(this.ruta(sesion.id), JSON.stringify({ ...sesion, ocupada: false }))
    } catch {
      // Persistir es un respaldo; la sesión sigue viva en memoria.
    }
  }

  private descartarMasAntigua(): void {
    const libre = [...this.sesiones.values()].filter((s) => !s.ocupada).sort((a, b) => a.creada.localeCompare(b.creada))[0]
    if (libre) this.sesiones.delete(libre.id)
  }
}
