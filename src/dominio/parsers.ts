import type { Cotizacion, Factura } from "./tipos.ts"

/** "900.555.111-2" → "900555111" (sin puntos ni dígito de verificación). */
export function normalizarNit(nit: string): string {
  return nit.replace(/[\s.]/g, "").replace(/-\d$/, "")
}

/** Nombre comparable: sin tildes, sin puntuación y sin sufijo societario. */
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(sas|s a s|ltda|sa|s a)\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** Monto en formato colombiano ("11.400.000" o "1.234,50") o anglosajón ("11,400,000.00"). */
export function parsearMonto(texto: string): number | null {
  const t = texto.trim()
  let normal: string
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) normal = t.replace(/\./g, "").replace(",", ".")
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) normal = t.replace(/,/g, "")
  else if (/^\d+([.,]\d+)?$/.test(t)) normal = t.replace(",", ".")
  else return null
  const n = Number(normal)
  return Number.isFinite(n) ? n : null
}

export function sumarDias(fechaIso: string, dias: number): string {
  const d = new Date(`${fechaIso.slice(0, 10)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

/** Fecha calendario (AAAA-MM-DD) de un ISO con zona horaria: se respeta la fecha local del remitente. */
export const fechaCalendario = (iso: string): string => iso.slice(0, 10)

const linea = (texto: string, patron: RegExp): string | null => texto.match(patron)?.[1]?.trim() ?? null

export type ResultadoParseo<T> = { valor: T } | { error: string }

export function parsearCotizacion(texto: string): ResultadoParseo<Cotizacion> {
  const proveedor = linea(texto, /^Proveedor:\s*(.+)$/m)
  const total = texto.match(/^TOTAL\b[^:\n]*:\s*([A-Z]{3})\s*([\d.,]+)/m)
  const monto = total?.[2] ? parsearMonto(total[2]) : null
  if (!proveedor) return { error: "cotización ilegible: no se encontró la línea 'Proveedor:'" }
  if (!total?.[1] || monto === null) return { error: "cotización ilegible: no se encontró un TOTAL numérico" }

  const fecha = linea(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m)
  const nit = linea(texto, /^NIT:\s*([\d.\-\s]+)$/m)
  const validezDias = linea(texto, /^Validez[^:\n]*:\s*(\d+)\s*d[ií]as/im)
  const iva = linea(texto, /^IVA\s+(\d+(?:[.,]\d+)?)\s*%/m)

  return {
    valor: {
      numero: linea(texto, /COTIZACI[ÓO]N\s+([A-Z0-9][A-Z0-9-]*)/i),
      fecha,
      proveedor,
      nit: nit ? normalizarNit(nit) : null,
      total: monto,
      moneda: total[1],
      iva_tasa: iva ? Number(iva.replace(",", ".")) / 100 : null,
      validez_hasta: fecha && validezDias ? sumarDias(fecha, Number(validezDias)) : null,
      texto,
    },
  }
}

export function parsearFactura(texto: string): ResultadoParseo<Factura> {
  const numero = linea(texto, /No\.\s*([A-Z0-9][A-Z0-9-]*)/)
  const fecha = linea(texto, /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i)
  const total = linea(texto, /^TOTAL:\s*[A-Z]{3}\s*([\d.,]+)/m)
  const monto = total ? parsearMonto(total) : null
  if (!fecha) return { error: "factura ilegible: no se encontró la fecha de emisión" }
  return { valor: { numero: numero ?? "(sin número)", fecha, total: monto ?? 0 } }
}

/**
 * RC2 exige que el cuerpo "contenga Aprobado". Se descartan negaciones explícitas
 * ("no aprobado", "sin aprobar") y rechazos, que contienen la palabra pero dicen lo contrario.
 */
export function esAprobacion(cuerpo: string): boolean {
  const t = cuerpo.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  if (!/\baprobad[oa]\b/.test(t)) return false
  return !/\b(no|sin)\s+(esta\s+|queda\s+)?aprobad[oa]\b/.test(t) && !/\brechazad[oa]\b/.test(t)
}
