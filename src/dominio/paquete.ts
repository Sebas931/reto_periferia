import { join } from "node:path"
import { existe, leerJson, leerTexto, listarDirectorios } from "./archivos.ts"
import { esAprobacion, parsearCotizacion, parsearFactura } from "./parsers.ts"
import { RUTAS } from "./reglas.ts"
import { fallo, exito, type Resultado } from "./resultado.ts"
import {
  AprobacionArchivoSchema,
  CorreoSchema,
  describirErrores,
  SolicitudSchema,
  type Aprobacion,
  type Paquete,
} from "./tipos.ts"

/**
 * Acepta "sol-004", "SOL-004", "SOL-2026-004", "sol 4" o "4" y devuelve la carpeta "sol-004".
 * El resultado solo puede tener la forma sol-NNN, así que no hay forma de salir de fixtures/ (path traversal).
 */
export async function resolverCaso(directorio: string, entrada: string): Promise<Resultado<string>> {
  const digitos = entrada.trim().match(/(\d+)\s*$/)?.[1]
  const disponibles = await listarCasos(directorio)
  if (!digitos) return fallo(`caso '${entrada}' no reconocido. Casos disponibles: ${disponibles.join(", ")}`, "CASO_INVALIDO")
  const caso = `sol-${String(Number(digitos)).padStart(3, "0")}`
  if (!(await existe(join(directorio, RUTAS.solicitudes, caso)))) {
    return fallo(`el caso '${caso}' no existe. Casos disponibles: ${disponibles.join(", ")}`, "CASO_INVALIDO")
  }
  return exito(caso)
}

export async function listarCasos(directorio: string): Promise<string[]> {
  const carpetas = await listarDirectorios(join(directorio, RUTAS.solicitudes))
  return carpetas.filter((c) => /^sol-\d{3}$/.test(c))
}

/**
 * HU-1. Correo y solicitud son obligatorios: si faltan o están malformados, el paquete no se puede procesar.
 * Cotización, aprobación y factura pueden faltar: quedan en null y se listan en `faltantes`
 * para que los controles decidan (RC2 bloquea sin aprobación, RC5 pide confirmación sin cotización).
 */
export async function leerPaquete(directorio: string, entrada: string): Promise<Resultado<Paquete>> {
  const resuelto = await resolverCaso(directorio, entrada)
  if (!resuelto.ok) return resuelto
  const caso = resuelto.data
  const carpeta = join(directorio, RUTAS.solicitudes, caso)

  const correoJson = await leerJson(join(carpeta, "correo.json"))
  if (correoJson.estado !== "ok") {
    return fallo(
      `${caso}: correo.json ${correoJson.estado === "ausente" ? "no existe" : correoJson.error}. Pida al solicitante reenviar el correo.`,
      "PAQUETE_INCOMPLETO",
      caso,
    )
  }
  const correo = CorreoSchema.safeParse(correoJson.valor)
  if (!correo.success) return fallo(`${caso}: ${describirErrores(correo.error, "correo.json")}`, "DATOS_INVALIDOS", caso)

  const solicitudJson = await leerJson(join(carpeta, "solicitud.json"))
  if (solicitudJson.estado !== "ok") {
    return fallo(
      `${caso}: la solicitud de compra (solicitud.json) ${solicitudJson.estado === "ausente" ? "no está adjunta" : solicitudJson.error}. Pida al solicitante el Excel de solicitud.`,
      "PAQUETE_INCOMPLETO",
      caso,
    )
  }
  const solicitud = SolicitudSchema.safeParse(solicitudJson.valor)
  if (!solicitud.success) {
    return fallo(
      `${caso}: ${describirErrores(solicitud.error, "solicitud.json")}. Pida al solicitante corregir la solicitud.`,
      "DATOS_INVALIDOS",
      caso,
    )
  }

  const faltantes: string[] = []

  let cotizacion: Paquete["cotizacion"] = null
  const cotTexto = await leerTexto(join(carpeta, "cotizacion.txt"))
  if (cotTexto.estado === "ok") {
    const parseo = parsearCotizacion(cotTexto.valor)
    if ("valor" in parseo) cotizacion = parseo.valor
    else faltantes.push(`cotizacion (${parseo.error})`)
  } else faltantes.push(cotTexto.estado === "ausente" ? "cotizacion" : `cotizacion (${cotTexto.error})`)

  let aprobacion: Aprobacion | null = null
  const aprJson = await leerJson(join(carpeta, "aprobacion.json"))
  if (aprJson.estado === "invalido") return fallo(`${caso}: aprobacion.json ${aprJson.error}`, "DATOS_INVALIDOS", caso)
  if (aprJson.estado === "ausente") faltantes.push("aprobacion")
  else {
    const apr = AprobacionArchivoSchema.safeParse(aprJson.valor)
    if (!apr.success) return fallo(`${caso}: ${describirErrores(apr.error, "aprobacion.json")}`, "DATOS_INVALIDOS", caso)
    aprobacion = {
      de: apr.data.de.toLowerCase(),
      para: apr.data.para ?? null,
      cc: apr.data.cc ?? [],
      asunto: apr.data.asunto ?? null,
      fecha: apr.data.fecha,
      aprobado: esAprobacion(apr.data.cuerpo),
      texto: apr.data.cuerpo,
    }
  }

  // La factura solo existe en compras retroactivas: su ausencia es lo normal y no se reporta como faltante.
  let factura: Paquete["factura"] = null
  const facTexto = await leerTexto(join(carpeta, "factura.txt"))
  if (facTexto.estado === "ok") {
    const parseo = parsearFactura(facTexto.valor)
    if ("valor" in parseo) factura = parseo.valor
    else faltantes.push(`factura (${parseo.error})`)
  }

  return exito({
    caso,
    correo: { id: correo.data.id, de: correo.data.de, asunto: correo.data.asunto, fecha: correo.data.fecha },
    solicitud: solicitud.data,
    cotizacion,
    aprobacion,
    factura,
    faltantes,
  })
}
