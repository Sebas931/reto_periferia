import { agregarLinea, existe, rutaSalida } from "./archivos.ts"

export type ResultadoIntento = "creada" | "existente" | "bloqueada" | "pendiente_confirmacion" | "error"

export type FilaControl = {
  solicitud_id: string
  resultado: ResultadoIntento
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const COLUMNAS = ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"] as const

const csv = (v: string): string => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/** HU-5: cada intento de crear (exitoso, bloqueado o pendiente) deja una fila en out/control.csv. */
export async function registrarIntento(directorio: string, fila: FilaControl): Promise<void> {
  const ruta = rutaSalida(directorio, "control.csv")
  if (!(await existe(ruta))) await agregarLinea(ruta, COLUMNAS.join(","))
  const valores = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? "",
    String(fila.retroactiva),
    fila.bloqueos.join(";"),
    fila.confirmaciones.join(";"),
    new Date().toISOString(),
  ]
  await agregarLinea(ruta, valores.map(csv).join(","))
}
