/**
 * Parámetros de negocio. Cambiar una tolerancia o una constante SAP se hace aquí,
 * sin tocar el servidor ni las herramientas.
 */
export const REGLAS = {
  /** RC5: diferencia máxima relativa entre cotización y solicitud. */
  toleranciaCotizacion: 0.02,
  /** RC10: diferencia máxima absoluta entre cantidad × valor_unitario y valor_total. */
  toleranciaAritmetica: 1,
  /** Límite SAP del texto breve de la posición. */
  maxDescripcionPosicion: 40,
  /** Primer número de OC del SAP simulado. */
  primerNumeroOc: 4500000001,
  sociedad: "1000",
  organizacionCompras: "1000",
  monedas: ["COP", "USD"],
} as const

export const RUTAS = {
  fixtures: "fixtures/reto-03",
  solicitudes: "fixtures/reto-03/solicitudes",
  maestros: "fixtures/reto-03/maestros",
  salida: "out",
} as const
