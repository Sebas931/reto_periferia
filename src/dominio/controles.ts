import { buscarProveedor } from "./maestros.ts"
import { fechaCalendario } from "./parsers.ts"
import { REGLAS } from "./reglas.ts"
import type { CentroCosto, Maestros, Paquete, Proveedor } from "./tipos.ts"

export type TipoControl = "bloqueo" | "confirmacion" | "derivado"
export type EstadoControl = "cumple" | "bloqueo" | "confirmacion" | "derivado" | "no_evaluable"

export type ResultadoControl = {
  codigo: string
  nombre: string
  tipo: TipoControl
  estado: EstadoControl
  detalle: string
  accion_sugerida?: string
  valores?: Record<string, string | number | boolean | null>
}

export type Derivado = { valor: string; fuente: string; motivo: string }

export type Validacion = {
  caso: string
  solicitud_id: string
  apta: boolean
  bloqueos: Array<{ codigo: string; detalle: string; accion_sugerida: string }>
  confirmaciones: Array<{ codigo: string; detalle: string; valores?: ResultadoControl["valores"] }>
  derivados: { indicador_iva?: Derivado; condiciones_pago?: Derivado }
  retroactiva: boolean
  proveedor: { codigo_sap: string; nit: string; nombre: string; criterio: "nit" | "nombre" } | null
  controles: ResultadoControl[]
  advertencias: string[]
}

type Contexto = {
  paquete: Paquete
  maestros: Maestros
  proveedor: Proveedor | null
  centro: CentroCosto | null
}

const pesos = (n: number): string => `${new Intl.NumberFormat("es-CO").format(n)}`
const cumple = (codigo: string, nombre: string, tipo: TipoControl, detalle: string): ResultadoControl => ({
  codigo,
  nombre,
  tipo,
  estado: "cumple",
  detalle,
})

function rc1Proveedor({ paquete }: Contexto, encontrado: ReturnType<typeof buscarProveedor>): ResultadoControl {
  const base = { codigo: "RC1", nombre: "Proveedor existe y está activo", tipo: "bloqueo" as const }
  const nit = paquete.solicitud.proveedor_nit ?? paquete.cotizacion?.nit ?? null
  const criterio = nit ? `NIT ${nit}` : `nombre '${paquete.solicitud.proveedor_nombre}'`
  if (!encontrado) {
    return {
      ...base,
      estado: "bloqueo",
      detalle: `El proveedor '${paquete.solicitud.proveedor_nombre}' (${criterio}) no existe en el maestro de proveedores.`,
      accion_sugerida:
        "Solicitar a compras la creación del proveedor en SAP (RUT, certificación bancaria, cámara de comercio) y reprocesar la solicitud.",
    }
  }
  const p = encontrado.proveedor
  if (!p.activo) {
    return {
      ...base,
      estado: "bloqueo",
      detalle: `El proveedor ${p.nombre} (código SAP ${p.codigo_sap}) está INACTIVO en el maestro.`,
      accion_sugerida: "Solicitar a compras la reactivación del proveedor o elegir un proveedor activo.",
    }
  }
  return cumple(base.codigo, base.nombre, base.tipo, `${p.nombre} — código SAP ${p.codigo_sap}, activo (encontrado por ${encontrado.criterio}).`)
}

function aprobadoresSuficientes(centro: CentroCosto, valor: number): string {
  const aptos = centro.aprobadores.filter((a) => a.tope >= valor)
  return aptos.length
    ? aptos.map((a) => `${a.nombre ?? a.email} <${a.email}> (tope ${pesos(a.tope)})`).join(", ")
    : ""
}

function rc2Aprobador({ paquete, centro }: Contexto): ResultadoControl {
  const base = { codigo: "RC2", nombre: "Aprobación válida del líder del centro de costo", tipo: "bloqueo" as const }
  const apr = paquete.aprobacion
  const cc = paquete.solicitud.centro_costo
  if (!apr) {
    return {
      ...base,
      estado: "bloqueo",
      detalle: "No hay correo de aprobación en el paquete.",
      accion_sugerida: centro
        ? `Pedir la aprobación por correo a un aprobador de ${cc}: ${centro.aprobadores.map((a) => a.email).join(", ")}.`
        : "Pedir al solicitante el correo de aprobación de su líder.",
    }
  }
  if (!apr.aprobado) {
    return {
      ...base,
      estado: "bloqueo",
      detalle: `El correo de ${apr.de} no contiene una aprobación explícita ("Aprobado").`,
      accion_sugerida: "Pedir al líder una respuesta explícita con la palabra 'Aprobado'.",
    }
  }
  if (!centro) {
    return { ...base, estado: "no_evaluable", detalle: `El centro de costo ${cc} no existe; no se puede verificar el aprobador.` }
  }
  const autorizado = centro.aprobadores.find((a) => a.email.toLowerCase() === apr.de)
  if (!autorizado) {
    const aptos = aprobadoresSuficientes(centro, paquete.solicitud.valor_total)
    return {
      ...base,
      estado: "bloqueo",
      detalle: `${apr.de} aprobó, pero no es aprobador del centro ${cc}. Aprobadores de ${cc}: ${centro.aprobadores.map((a) => a.email).join(", ")}.`,
      accion_sugerida: aptos
        ? `Solicitar la aprobación a un aprobador de ${cc} con tope suficiente: ${aptos}.`
        : `Ningún aprobador de ${cc} tiene tope para ${pesos(paquete.solicitud.valor_total)}; escalar a la dirección financiera para aprobación extraordinaria.`,
    }
  }
  return cumple(base.codigo, base.nombre, base.tipo, `Aprobado por ${autorizado.nombre ?? apr.de}, aprobador registrado de ${cc}.`)
}

function rc3Tope({ paquete, centro }: Contexto): ResultadoControl {
  const base = { codigo: "RC3", nombre: "Valor dentro del tope del aprobador", tipo: "bloqueo" as const }
  const apr = paquete.aprobacion
  const valor = paquete.solicitud.valor_total
  const autorizado = centro?.aprobadores.find((a) => a.email.toLowerCase() === apr?.de)
  if (!centro || !autorizado) {
    return { ...base, estado: "no_evaluable", detalle: "No hay un aprobador válido del centro de costo contra el cual comparar el tope (ver RC2)." }
  }
  if (valor > autorizado.tope) {
    const aptos = aprobadoresSuficientes(centro, valor)
    return {
      ...base,
      estado: "bloqueo",
      detalle: `El valor ${pesos(valor)} supera el tope de ${autorizado.email} (${pesos(autorizado.tope)}).`,
      accion_sugerida: aptos
        ? `Solicitar aprobación a: ${aptos}.`
        : `Ningún aprobador de ${centro.centro_costo} tiene tope suficiente; escalar a la dirección financiera.`,
      valores: { valor_total: valor, tope: autorizado.tope },
    }
  }
  return cumple(base.codigo, base.nombre, base.tipo, `${pesos(valor)} ≤ tope ${pesos(autorizado.tope)} de ${autorizado.email}.`)
}

function rc4Subarea({ paquete, centro, maestros }: Contexto): ResultadoControl {
  const base = { codigo: "RC4", nombre: "Subárea pertenece al centro de costo", tipo: "bloqueo" as const }
  const { centro_costo, subarea } = paquete.solicitud
  if (!centro) {
    return {
      ...base,
      estado: "bloqueo",
      detalle: `El centro de costo ${centro_costo} no existe en el maestro.`,
      accion_sugerida: `Pedir al solicitante un centro de costo válido (${maestros.centrosCosto.map((c) => c.centro_costo).join(", ")}).`,
    }
  }
  if (!centro.subareas.includes(subarea)) {
    return {
      ...base,
      estado: "bloqueo",
      detalle: `La subárea '${subarea}' no pertenece a ${centro_costo} (válidas: ${centro.subareas.join(", ")}).`,
      accion_sugerida: "Pedir al solicitante corregir la subárea o el centro de costo.",
    }
  }
  return cumple(base.codigo, base.nombre, base.tipo, `${subarea} pertenece a ${centro_costo} (${centro.nombre ?? ""}).`.replace(" ()", ""))
}

function rc5Cotizacion({ paquete }: Contexto): ResultadoControl {
  const base = { codigo: "RC5", nombre: "Cotización coincide con la solicitud (±2 %)", tipo: "confirmacion" as const }
  const { cotizacion, solicitud } = paquete
  if (!cotizacion) {
    return { ...base, estado: "confirmacion", detalle: "No hay cotización legible del proveedor; la OC se crearía sin soporte de precio." }
  }
  const diferencia = cotizacion.total - solicitud.valor_total
  const pct = Math.abs(diferencia) / solicitud.valor_total
  const valores = {
    valor_solicitud: solicitud.valor_total,
    valor_cotizacion: cotizacion.total,
    diferencia,
    diferencia_pct: Math.round(pct * 10000) / 100,
  }
  if (cotizacion.moneda !== solicitud.moneda) {
    return {
      ...base,
      estado: "confirmacion",
      detalle: `La cotización está en ${cotizacion.moneda} y la solicitud en ${solicitud.moneda}.`,
      valores,
    }
  }
  if (pct > REGLAS.toleranciaCotizacion) {
    return {
      ...base,
      estado: "confirmacion",
      detalle: `La cotización ${cotizacion.numero ?? ""} suma ${pesos(cotizacion.total)} y la solicitud ${pesos(solicitud.valor_total)}: diferencia de ${pesos(diferencia)} (${valores.diferencia_pct} %), mayor al ${REGLAS.toleranciaCotizacion * 100} % permitido.`.replace("  ", " "),
      valores,
    }
  }
  return { ...cumple(base.codigo, base.nombre, base.tipo, `Cotización ${pesos(cotizacion.total)} vs solicitud ${pesos(solicitud.valor_total)} (diferencia ${valores.diferencia_pct} %).`), valores }
}

function rc6Iva({ paquete, maestros, proveedor }: Contexto): { control: ResultadoControl; derivado?: Derivado } {
  const base = { codigo: "RC6", nombre: "Indicador de IVA informado", tipo: "confirmacion" as const }
  const informado = paquete.solicitud.indicador_iva
  if (informado) {
    const ind = maestros.indicadoresIva.find((i) => i.codigo === informado)
    if (!ind) {
      return {
        control: {
          ...base,
          tipo: "bloqueo",
          estado: "bloqueo",
          detalle: `El indicador de IVA '${informado}' no existe (válidos: ${maestros.indicadoresIva.map((i) => i.codigo).join(", ")}).`,
          accion_sugerida: "Pedir al solicitante el indicador de IVA correcto.",
        },
      }
    }
    return { control: cumple(base.codigo, base.nombre, base.tipo, `${ind.codigo} — ${ind.descripcion}, informado en la solicitud.`) }
  }
  if (!proveedor) {
    return { control: { ...base, estado: "no_evaluable", detalle: "Indicador de IVA ausente y no hay proveedor válido del cual derivarlo (ver RC1)." } }
  }
  const codigo = proveedor.indicador_iva_default
  const ind = maestros.indicadoresIva.find((i) => i.codigo === codigo)
  const tasaCot = paquete.cotizacion?.iva_tasa
  const coincide =
    ind && tasaCot !== null && tasaCot !== undefined
      ? Math.abs(ind.tasa - tasaCot) < 1e-9
        ? ` Coincide con el IVA ${tasaCot * 100} % de la cotización.`
        : ` ATENCIÓN: la cotización liquida IVA ${tasaCot * 100} %, distinto a la tasa del indicador (${ind.tasa * 100} %).`
      : ""
  return {
    control: {
      ...base,
      estado: "confirmacion",
      detalle: `La solicitud no informa indicador de IVA. Se propone ${codigo}${ind ? ` (${ind.descripcion})` : ""}, el default del proveedor ${proveedor.nombre.replace(/\.$/, "")}.${coincide}`,
      valores: { indicador_propuesto: codigo, tasa: ind?.tasa ?? null, tasa_cotizacion: tasaCot ?? null },
    },
    derivado: { valor: codigo, fuente: "maestro.proveedores", motivo: "indicador_iva ausente en la solicitud (RC6)" },
  }
}

function rc7CondicionesPago({ paquete, maestros, proveedor }: Contexto): { control: ResultadoControl; derivado?: Derivado } {
  const base = { codigo: "RC7", nombre: "Condiciones de pago", tipo: "derivado" as const }
  const informado = paquete.solicitud.condiciones_pago
  if (informado) {
    const cond = maestros.condicionesPago.find((c) => c.codigo === informado)
    if (!cond) {
      return {
        control: {
          ...base,
          tipo: "bloqueo",
          estado: "bloqueo",
          detalle: `La condición de pago '${informado}' no existe (válidas: ${maestros.condicionesPago.map((c) => c.codigo).join(", ")}).`,
          accion_sugerida: "Pedir al solicitante la condición de pago correcta u omitirla para usar la del proveedor.",
        },
      }
    }
    return { control: cumple(base.codigo, base.nombre, base.tipo, `${cond.codigo} — ${cond.descripcion}, informada en la solicitud.`) }
  }
  if (!proveedor) {
    return { control: { ...base, estado: "no_evaluable", detalle: "Condiciones de pago ausentes y no hay proveedor válido del cual derivarlas (ver RC1)." } }
  }
  const codigo = proveedor.condiciones_pago_default
  const cond = maestros.condicionesPago.find((c) => c.codigo === codigo)
  return {
    control: {
      ...base,
      estado: "derivado",
      detalle: `La solicitud no informa condiciones de pago. Se usa ${codigo}${cond ? ` (${cond.descripcion})` : ""}, el default del proveedor.`,
    },
    derivado: { valor: codigo, fuente: "maestro.proveedores", motivo: "condiciones_pago ausentes en la solicitud (RC7)" },
  }
}

function rc8Retroactiva({ paquete }: Contexto): ResultadoControl {
  const base = { codigo: "RC8", nombre: "OC no retroactiva (factura posterior a la solicitud)", tipo: "confirmacion" as const }
  const { factura, solicitud } = paquete
  if (!factura) return cumple(base.codigo, base.nombre, base.tipo, "No hay factura previa en el paquete.")
  if (factura.fecha < solicitud.fecha_solicitud) {
    return {
      ...base,
      estado: "confirmacion",
      detalle: `RETROACTIVA: la factura ${factura.numero} es del ${factura.fecha}, anterior a la solicitud del ${solicitud.fecha_solicitud}. La compra se hizo antes de crear la OC.`,
      valores: { fecha_factura: factura.fecha, fecha_solicitud: solicitud.fecha_solicitud, factura: factura.numero },
    }
  }
  return cumple(base.codigo, base.nombre, base.tipo, `La factura ${factura.numero} (${factura.fecha}) es posterior a la solicitud.`)
}

function rc9FechaAprobacion({ paquete }: Contexto): ResultadoControl {
  const base = { codigo: "RC9", nombre: "Aprobación en o después de la solicitud", tipo: "confirmacion" as const }
  const apr = paquete.aprobacion
  if (!apr) return { ...base, estado: "no_evaluable", detalle: "No hay aprobación (ver RC2)." }
  const fecha = fechaCalendario(apr.fecha)
  if (fecha < paquete.solicitud.fecha_solicitud) {
    return {
      ...base,
      estado: "confirmacion",
      detalle: `La aprobación (${fecha}) es anterior a la solicitud (${paquete.solicitud.fecha_solicitud}).`,
      valores: { fecha_aprobacion: fecha, fecha_solicitud: paquete.solicitud.fecha_solicitud },
    }
  }
  return cumple(base.codigo, base.nombre, base.tipo, `Aprobación ${fecha} ≥ solicitud ${paquete.solicitud.fecha_solicitud}.`)
}

function rc10Aritmetica({ paquete }: Contexto): ResultadoControl {
  const base = { codigo: "RC10", nombre: "Cantidad × valor unitario = valor total (±1)", tipo: "bloqueo" as const }
  const { cantidad, valor_unitario, valor_total } = paquete.solicitud
  const calculado = cantidad * valor_unitario
  if (Math.abs(calculado - valor_total) > REGLAS.toleranciaAritmetica) {
    return {
      ...base,
      estado: "bloqueo",
      detalle: `${cantidad} × ${pesos(valor_unitario)} = ${pesos(calculado)}, pero la solicitud dice ${pesos(valor_total)}.`,
      accion_sugerida: "Pedir al solicitante corregir cantidad, valor unitario o valor total.",
      valores: { calculado, valor_total },
    }
  }
  return cumple(base.codigo, base.nombre, base.tipo, `${cantidad} × ${pesos(valor_unitario)} = ${pesos(calculado)}.`)
}

/** HU-2. Función pura: mismo paquete y mismos maestros → mismo resultado. */
export function evaluarControles(paquete: Paquete, maestros: Maestros): Validacion {
  const nitBusqueda = paquete.solicitud.proveedor_nit ?? paquete.cotizacion?.nit ?? null
  const encontrado = buscarProveedor(maestros, nitBusqueda, paquete.solicitud.proveedor_nombre)
  const ctx: Contexto = {
    paquete,
    maestros,
    proveedor: encontrado && encontrado.proveedor.activo ? encontrado.proveedor : null,
    centro: maestros.centrosCosto.find((c) => c.centro_costo === paquete.solicitud.centro_costo) ?? null,
  }

  const iva = rc6Iva(ctx)
  const pago = rc7CondicionesPago(ctx)
  const controles = [
    rc1Proveedor(ctx, encontrado),
    rc2Aprobador(ctx),
    rc3Tope(ctx),
    rc4Subarea(ctx),
    rc5Cotizacion(ctx),
    iva.control,
    pago.control,
    rc8Retroactiva(ctx),
    rc9FechaAprobacion(ctx),
    rc10Aritmetica(ctx),
  ]

  const advertencias: string[] = []
  const { solicitud, cotizacion } = paquete
  if (solicitud.proveedor_nit && cotizacion?.nit && solicitud.proveedor_nit !== cotizacion.nit) {
    advertencias.push(`El NIT de la solicitud (${solicitud.proveedor_nit}) difiere del de la cotización (${cotizacion.nit}).`)
  }
  if (cotizacion?.validez_hasta && cotizacion.validez_hasta < solicitud.fecha_solicitud) {
    advertencias.push(`La cotización venció el ${cotizacion.validez_hasta}, antes de la solicitud.`)
  }
  for (const f of paquete.faltantes) advertencias.push(`Adjunto faltante o ilegible: ${f}.`)

  const bloqueos = controles
    .filter((c) => c.estado === "bloqueo")
    .map((c) => ({ codigo: c.codigo, detalle: c.detalle, accion_sugerida: c.accion_sugerida ?? "" }))
  const confirmaciones = controles
    .filter((c) => c.estado === "confirmacion")
    .map((c) => ({ codigo: c.codigo, detalle: c.detalle, ...(c.valores ? { valores: c.valores } : {}) }))

  return {
    caso: paquete.caso,
    solicitud_id: solicitud.solicitud_id,
    apta: bloqueos.length === 0,
    bloqueos,
    confirmaciones,
    derivados: {
      ...(iva.derivado ? { indicador_iva: iva.derivado } : {}),
      ...(pago.derivado ? { condiciones_pago: pago.derivado } : {}),
    },
    retroactiva: Boolean(paquete.factura && paquete.factura.fecha < solicitud.fecha_solicitud),
    proveedor: ctx.proveedor
      ? { codigo_sap: ctx.proveedor.codigo_sap, nit: ctx.proveedor.nit, nombre: ctx.proveedor.nombre, criterio: encontrado!.criterio }
      : null,
    controles,
    advertencias,
  }
}
