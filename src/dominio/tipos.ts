import { z } from "zod"

const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "debe ser una fecha AAAA-MM-DD")
const numero = (campo: string) =>
  z.number({ error: (i) => `${campo} debe ser numérico (recibido: ${JSON.stringify(i.input)})` })

// ── Fixtures de entrada (7.1) ──────────────────────────────────────────────

export const CorreoSchema = z.object({
  id: z.string().min(1),
  de: z.string().min(1),
  para: z.string().optional(),
  asunto: z.string(),
  fecha: z.string().min(1),
  cuerpo: z.string().optional(),
  adjuntos: z.array(z.string()).optional(),
})

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string().min(1),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().min(1).optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: numero("cantidad").positive("cantidad debe ser mayor que cero"),
  valor_unitario: numero("valor_unitario").nonnegative(),
  valor_total: numero("valor_total").positive("valor_total debe ser mayor que cero"),
  moneda: z.enum(["COP", "USD"], { error: (i) => `moneda no soportada: ${JSON.stringify(i.input)} (válidas: COP, USD)` }),
  indicador_iva: z.string().min(1).optional(),
  condiciones_pago: z.string().min(1).optional(),
  fecha_solicitud: fechaIso,
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const AprobacionArchivoSchema = z.object({
  de: z.string().min(1),
  para: z.string().optional(),
  cc: z.array(z.string()).optional(),
  fecha: z.string().min(1),
  asunto: z.string().optional(),
  cuerpo: z.string(),
})

// ── Paquete normalizado (7.2) ─────────────────────────────────────────────

export type Cotizacion = {
  numero: string | null
  fecha: string | null
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  iva_tasa: number | null
  validez_hasta: string | null
  texto: string
}

export type Aprobacion = {
  de: string
  para: string | null
  cc: string[]
  asunto: string | null
  fecha: string
  aprobado: boolean
  texto: string
}

export type Factura = { numero: string; fecha: string; total: number }

export type Paquete = {
  caso: string
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: Aprobacion | null
  factura: Factura | null
  /** Adjuntos ausentes o ilegibles, por nombre. */
  faltantes: string[]
}

// ── Maestros ──────────────────────────────────────────────────────────────

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
export type Proveedor = z.infer<typeof ProveedorSchema>

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string().optional(), tope: z.number() })),
})
export type CentroCosto = z.infer<typeof CentroCostoSchema>

export const IndicadorIvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
export type IndicadorIva = z.infer<typeof IndicadorIvaSchema>

export const CondicionPagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })
export type CondicionPago = z.infer<typeof CondicionPagoSchema>

export type Maestros = {
  proveedores: Proveedor[]
  centrosCosto: CentroCosto[]
  indicadoresIva: IndicadorIva[]
  condicionesPago: CondicionPago[]
}

// ── Orden de compra (7.4) ─────────────────────────────────────────────────

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string().describe("Id de la solicitud de compra"),
    correo_id: z.string().describe("Id del correo de entrada"),
    cotizacion_ref: z.string().nullable().describe("Número de la cotización del proveedor"),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string().describe("Código de condición de pago, ej. Z030"),
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive(),
        descripcion: z.string().max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(
    z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() }),
  ),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

/** Formatea los errores de zod en una sola línea legible. */
export function describirErrores(error: z.ZodError, archivo: string): string {
  const partes = error.issues.map((i) => {
    const ruta = i.path.length ? i.path.join(".") : "(raíz)"
    return i.code === "invalid_type" && i.input === undefined ? `falta el campo '${ruta}'` : `'${ruta}': ${i.message}`
  })
  return `${archivo} inválido: ${partes.join("; ")}`
}
