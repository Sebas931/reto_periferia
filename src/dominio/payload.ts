import type { Validacion } from "./controles.ts"
import { contenidoEvidencia, sha256 } from "./evidencia.ts"
import { REGLAS } from "./reglas.ts"
import { OrdenCompraSchema, describirErrores, type OrdenCompra, type Paquete } from "./tipos.ts"

export type Fuente =
  | "solicitud"
  | "cotizacion"
  | "correo"
  | "aprobacion"
  | "maestro.proveedores"
  | "constante"
  | "derivado"

export type Traza = { valor: unknown; fuente: Fuente; detalle?: string }
export type Trazabilidad = Record<string, Traza>

/** Texto breve SAP: máximo 40 caracteres, cortando en palabra completa cuando se puede. */
export function textoBreve(descripcion: string): string {
  const max = REGLAS.maxDescripcionPosicion
  const limpio = descripcion.replace(/\s+/g, " ").trim()
  if (limpio.length <= max) return limpio
  const corte = limpio.slice(0, max + 1).lastIndexOf(" ")
  return (corte > max * 0.6 ? limpio.slice(0, corte) : limpio.slice(0, max)).replace(/[\s,;:.-]+$/, "")
}

/** Unidad de medida a partir del texto: horas → H, mensualidades → MES, resto → UN. */
export function inferirUnidad(paquete: Paquete): { unidad: "UN" | "H" | "MES"; motivo: string } {
  const texto = `${paquete.solicitud.descripcion}\n${paquete.cotizacion?.texto ?? ""}`.toLowerCase()
  if (/\bhoras?\b/.test(texto)) return { unidad: "H", motivo: "la descripción o la cotización se expresan en horas" }
  if (/\b(mensualidad(es)?|por mes|cuota mensual|canon mensual)\b/.test(texto)) {
    return { unidad: "MES", motivo: "la cotización se expresa por mes" }
  }
  return { unidad: "UN", motivo: "unidades (default)" }
}

/** Excepciones = confirmaciones aceptadas. `confirmadoPor` es null mientras nadie haya confirmado. */
export function excepcionesDe(validacion: Validacion, confirmadoPor: string | null): OrdenCompra["excepciones"] {
  return validacion.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: confirmadoPor }))
}

export type OrdenConstruida = { orden: OrdenCompra; trazabilidad: Trazabilidad }

/** HU-3. Solo se construye sobre una validación apta. Cada valor queda trazado a su fuente. */
export function construirOrden(
  paquete: Paquete,
  validacion: Validacion,
  confirmadoPor: string | null,
): { ok: true; valor: OrdenConstruida } | { ok: false; error: string } {
  if (!validacion.apta || !validacion.proveedor) {
    return { ok: false, error: `la solicitud no es apta: ${validacion.bloqueos.map((b) => `${b.codigo} ${b.detalle}`).join(" | ")}` }
  }
  const contenido = contenidoEvidencia(paquete)
  if (!paquete.aprobacion || !contenido) return { ok: false, error: "no hay aprobación para construir la evidencia" }

  const { solicitud, cotizacion, aprobacion, correo } = paquete
  const ivaDerivado = validacion.derivados.indicador_iva
  const pagoDerivado = validacion.derivados.condiciones_pago
  const indicadorIva = solicitud.indicador_iva ?? ivaDerivado?.valor
  const condicionesPago = solicitud.condiciones_pago ?? pagoDerivado?.valor
  if (!indicadorIva || !condicionesPago) return { ok: false, error: "no se pudo determinar indicador de IVA o condiciones de pago" }

  const descripcion = textoBreve(solicitud.descripcion)
  const unidad = inferirUnidad(paquete)
  const evidencia = sha256(contenido)

  const orden: OrdenCompra = {
    referencia: { solicitud_id: solicitud.solicitud_id, correo_id: correo.id, cotizacion_ref: cotizacion?.numero ?? null },
    sociedad: REGLAS.sociedad,
    organizacion_compras: REGLAS.organizacionCompras,
    proveedor: { codigo_sap: validacion.proveedor.codigo_sap, nit: validacion.proveedor.nit, nombre: validacion.proveedor.nombre },
    moneda: solicitud.moneda,
    condiciones_pago: condicionesPago,
    aprobador: { email: aprobacion.de, fecha_aprobacion: aprobacion.fecha, evidencia_sha256: evidencia },
    posiciones: [
      {
        numero: 10,
        descripcion,
        cantidad: solicitud.cantidad,
        unidad: unidad.unidad,
        precio_unitario: solicitud.valor_unitario,
        centro_costo: solicitud.centro_costo,
        subarea: solicitud.subarea,
        indicador_iva: indicadorIva,
      },
    ],
    excepciones: excepcionesDe(validacion, confirmadoPor),
  }

  const validada = OrdenCompraSchema.safeParse(orden)
  if (!validada.success) return { ok: false, error: describirErrores(validada.error, "payload de la OC") }

  const pos = "posiciones[0]"
  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": { valor: solicitud.solicitud_id, fuente: "solicitud" },
    "referencia.correo_id": { valor: correo.id, fuente: "correo" },
    "referencia.cotizacion_ref": { valor: orden.referencia.cotizacion_ref, fuente: "cotizacion", detalle: cotizacion ? "encabezado de la cotización" : "sin cotización" },
    sociedad: { valor: REGLAS.sociedad, fuente: "constante" },
    organizacion_compras: { valor: REGLAS.organizacionCompras, fuente: "constante" },
    "proveedor.codigo_sap": { valor: orden.proveedor.codigo_sap, fuente: "maestro.proveedores", detalle: `encontrado por ${validacion.proveedor.criterio}` },
    "proveedor.nit": { valor: orden.proveedor.nit, fuente: "maestro.proveedores" },
    "proveedor.nombre": { valor: orden.proveedor.nombre, fuente: "maestro.proveedores" },
    moneda: { valor: orden.moneda, fuente: "solicitud" },
    condiciones_pago: pagoDerivado
      ? { valor: condicionesPago, fuente: "derivado", detalle: `${pagoDerivado.fuente}: ${pagoDerivado.motivo}` }
      : { valor: condicionesPago, fuente: "solicitud" },
    "aprobador.email": { valor: aprobacion.de, fuente: "aprobacion" },
    "aprobador.fecha_aprobacion": { valor: aprobacion.fecha, fuente: "aprobacion" },
    "aprobador.evidencia_sha256": { valor: evidencia, fuente: "derivado", detalle: "sha256 del contenido de aprobacion.txt" },
    [`${pos}.numero`]: { valor: 10, fuente: "constante" },
    [`${pos}.descripcion`]: {
      valor: descripcion,
      fuente: "solicitud",
      ...(descripcion !== solicitud.descripcion ? { detalle: `truncada a ${REGLAS.maxDescripcionPosicion} caracteres; original: "${solicitud.descripcion}"` } : {}),
    },
    [`${pos}.cantidad`]: { valor: solicitud.cantidad, fuente: "solicitud" },
    [`${pos}.unidad`]: { valor: unidad.unidad, fuente: "derivado", detalle: unidad.motivo },
    [`${pos}.precio_unitario`]: { valor: solicitud.valor_unitario, fuente: "solicitud" },
    [`${pos}.centro_costo`]: { valor: solicitud.centro_costo, fuente: "solicitud" },
    [`${pos}.subarea`]: { valor: solicitud.subarea, fuente: "solicitud" },
    [`${pos}.indicador_iva`]: ivaDerivado
      ? { valor: indicadorIva, fuente: "derivado", detalle: `${ivaDerivado.fuente}: ${ivaDerivado.motivo}` }
      : { valor: indicadorIva, fuente: "solicitud" },
  }

  return { ok: true, valor: { orden: validada.data, trazabilidad } }
}

/** Compara dos órdenes ignorando quién confirmó; devuelve las rutas que difieren. */
export function diferenciasOrden(a: OrdenCompra, b: unknown): string[] {
  const parsed = OrdenCompraSchema.safeParse(b)
  if (!parsed.success) return ["(el payload recibido no cumple el esquema OrdenCompra)"]
  const limpiar = (o: OrdenCompra) => ({ ...o, excepciones: o.excepciones.map((e) => ({ codigo: e.codigo })) })
  const planoA = aplanar(limpiar(a))
  const planoB = aplanar(limpiar(parsed.data))
  const claves = new Set([...Object.keys(planoA), ...Object.keys(planoB)])
  return [...claves].filter((k) => planoA[k] !== planoB[k]).sort()
}

export function aplanar(valor: unknown, prefijo = "", salida: Record<string, unknown> = {}): Record<string, unknown> {
  if (valor !== null && typeof valor === "object") {
    for (const [k, v] of Object.entries(valor)) aplanar(v, prefijo ? `${prefijo}.${k}` : k, salida)
  } else salida[prefijo] = valor
  return salida
}

/** true si dos valores tienen las mismas hojas, sin importar el orden de las claves. */
export function mismoContenido(a: unknown, b: unknown): boolean {
  const pa = aplanar(a)
  const pb = aplanar(b)
  const claves = new Set([...Object.keys(pa), ...Object.keys(pb)])
  return [...claves].every((k) => pa[k] === pb[k])
}
