import { agregarLinea, leerTexto, rutaSalida } from "../dominio/archivos.ts"
import { cargarMaestros } from "../dominio/maestros.ts"
import { normalizarNit } from "../dominio/parsers.ts"
import { REGLAS } from "../dominio/reglas.ts"
import type { OrdenCompra } from "../dominio/tipos.ts"
import type { SapAdapter } from "./adapter.ts"

type Registro = { numero_oc: string; fecha: string; solicitud_id: string; orden: OrdenCompra }

/** Serializa las escrituras por directorio: dos "crear" simultáneos no pueden tomar el mismo número. */
const colas = new Map<string, Promise<unknown>>()
function enSerie<T>(clave: string, tarea: () => Promise<T>): Promise<T> {
  const previa = colas.get(clave) ?? Promise.resolve()
  const siguiente = previa.then(tarea, tarea)
  colas.set(clave, siguiente.catch(() => undefined))
  return siguiente
}

/** SAP simulado sobre out/sap/ordenes.jsonl. */
export class SapMock implements SapAdapter {
  constructor(private readonly directorio: string) {}

  private get archivo(): string {
    return rutaSalida(this.directorio, "sap", "ordenes.jsonl")
  }

  private async registros(): Promise<Registro[]> {
    const texto = await leerTexto(this.archivo)
    if (texto.estado !== "ok") return []
    return texto.valor
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Registro)
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const cargados = await cargarMaestros(this.directorio)
    if (!cargados.ok) throw new Error(cargados.error)
    const p = cargados.maestros.proveedores.find((x) => normalizarNit(x.nit) === normalizarNit(nit))
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const r = (await this.registros()).find((x) => x.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    return enSerie(this.archivo, async () => {
      const existentes = await this.registros()
      // Idempotencia también del lado "SAP": la referencia es la llave natural.
      const previa = existentes.find((x) => x.solicitud_id === orden.referencia.solicitud_id)
      if (previa) return { numero_oc: previa.numero_oc, fecha: previa.fecha }
      const numero_oc = String(REGLAS.primerNumeroOc + existentes.length)
      const fecha = new Date().toISOString().slice(0, 10)
      const registro: Registro = { numero_oc, fecha, solicitud_id: orden.referencia.solicitud_id, orden }
      await agregarLinea(this.archivo, JSON.stringify(registro))
      return { numero_oc, fecha }
    })
  }
}
