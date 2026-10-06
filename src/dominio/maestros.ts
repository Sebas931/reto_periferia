import { join } from "node:path"
import { z } from "zod"
import { leerJson } from "./archivos.ts"
import { normalizarNit, normalizarNombre } from "./parsers.ts"
import { RUTAS } from "./reglas.ts"
import {
  CentroCostoSchema,
  CondicionPagoSchema,
  describirErrores,
  IndicadorIvaSchema,
  ProveedorSchema,
  type Maestros,
  type Proveedor,
} from "./tipos.ts"

const ARCHIVOS = {
  proveedores: ["proveedores.json", z.array(ProveedorSchema)],
  centrosCosto: ["centros-costo.json", z.array(CentroCostoSchema)],
  indicadoresIva: ["indicadores-iva.json", z.array(IndicadorIvaSchema)],
  condicionesPago: ["condiciones-pago.json", z.array(CondicionPagoSchema)],
} as const

/** Lee y valida los cuatro maestros. Se releen en cada llamada: son pequeños y así un cambio no exige reiniciar. */
export async function cargarMaestros(directorio: string): Promise<{ ok: true; maestros: Maestros } | { ok: false; error: string }> {
  const resultado: Partial<Record<keyof Maestros, unknown>> = {}
  for (const [clave, [archivo, esquema]] of Object.entries(ARCHIVOS)) {
    const lectura = await leerJson(join(directorio, RUTAS.maestros, archivo))
    if (lectura.estado === "ausente") return { ok: false, error: `maestro ${archivo} no encontrado` }
    if (lectura.estado === "invalido") return { ok: false, error: `maestro ${archivo}: ${lectura.error}` }
    const validado = esquema.safeParse(lectura.valor)
    if (!validado.success) return { ok: false, error: describirErrores(validado.error, `maestro ${archivo}`) }
    resultado[clave as keyof Maestros] = validado.data
  }
  return { ok: true, maestros: resultado as Maestros }
}

export type BusquedaProveedor = { proveedor: Proveedor; criterio: "nit" | "nombre" } | null

/** RC1: por NIT; si no hay NIT, por nombre normalizado. */
export function buscarProveedor(maestros: Maestros, nit: string | null, nombre: string): BusquedaProveedor {
  if (nit) {
    const n = normalizarNit(nit)
    const p = maestros.proveedores.find((x) => normalizarNit(x.nit) === n)
    return p ? { proveedor: p, criterio: "nit" } : null
  }
  const objetivo = normalizarNombre(nombre)
  const p = maestros.proveedores.find((x) => normalizarNombre(x.nombre) === objetivo)
  return p ? { proveedor: p, criterio: "nombre" } : null
}
