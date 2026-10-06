import { createHash } from "node:crypto"
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib"
import type { Paquete } from "./tipos.ts"

/**
 * Contenido canónico de la evidencia. Es determinista (sin timestamps de ejecución):
 * el mismo correo produce siempre el mismo sha256, y por eso el payload puede citarlo
 * antes de que el archivo exista.
 */
export function contenidoEvidencia(paquete: Paquete): string | null {
  const apr = paquete.aprobacion
  if (!apr) return null
  return [
    "EVIDENCIA DE APROBACIÓN DE COMPRA",
    `Solicitud: ${paquete.solicitud.solicitud_id}`,
    `Correo de origen: ${paquete.correo.id}`,
    "",
    `De: ${apr.de}`,
    `Para: ${apr.para ?? "(no informado)"}`,
    `CC: ${apr.cc.length ? apr.cc.join(", ") : "(ninguno)"}`,
    `Fecha: ${apr.fecha}`,
    `Asunto: ${apr.asunto ?? "(sin asunto)"}`,
    "",
    apr.texto,
  ].join("\n")
}

export const sha256 = (texto: string): string => createHash("sha256").update(texto, "utf8").digest("hex")

export function textoEvidencia(contenido: string, hash: string): string {
  return `${contenido}\n\n---\nSHA-256 del contenido anterior: ${hash}\n`
}

/** Reemplaza caracteres que la fuente estándar del PDF (WinAnsi) no puede codificar. */
function codificable(fuente: PDFFont, texto: string): string {
  const soportados = new Set(fuente.getCharacterSet())
  return [...texto].map((c) => (soportados.has(c.codePointAt(0) ?? 0) ? c : "?")).join("")
}

function partirLinea(fuente: PDFFont, linea: string, tamano: number, ancho: number): string[] {
  if (!linea) return [""]
  const palabras = linea.split(" ")
  const salida: string[] = []
  let actual = ""
  for (const palabra of palabras) {
    const candidata = actual ? `${actual} ${palabra}` : palabra
    if (fuente.widthOfTextAtSize(candidata, tamano) <= ancho || !actual) actual = candidata
    else {
      salida.push(actual)
      actual = palabra
    }
  }
  salida.push(actual)
  return salida
}

/** P1: el mismo contenido en PDF, con el hash al pie. */
export async function pdfEvidencia(contenido: string, hash: string, fechaDocumento: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fuente = await doc.embedFont(StandardFonts.Helvetica)
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold)
  doc.setTitle("Evidencia de aprobación de compra")
  doc.setProducer("Agente OC — Periferia IT Group (reto 03)")
  const fecha = new Date(fechaDocumento)
  if (!Number.isNaN(fecha.getTime())) {
    doc.setCreationDate(fecha)
    doc.setModificationDate(fecha)
  }

  const margen = 56
  const tamano = 11
  const interlineado = 16
  let pagina = doc.addPage([595.28, 841.89])
  const ancho = pagina.getWidth() - margen * 2
  let y = pagina.getHeight() - margen

  const lineas = [...contenido.split("\n"), "", "---", `SHA-256 del contenido: ${hash}`]
  lineas.forEach((original, indice) => {
    const f = indice === 0 ? negrita : fuente
    for (const linea of partirLinea(f, codificable(f, original), tamano, ancho)) {
      if (y < margen) {
        pagina = doc.addPage([595.28, 841.89])
        y = pagina.getHeight() - margen
      }
      pagina.drawText(linea, { x: margen, y, size: indice === 0 ? 13 : tamano, font: f, color: rgb(0.1, 0.1, 0.1) })
      y -= interlineado
    }
  })
  return doc.save()
}
