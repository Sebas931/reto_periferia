/**
 * Pruebas del ciclo del agente con un modelo simulado (sin clave ni red):
 * confirmación humana (CA3), tope de iteraciones (CA1) y errores del proveedor (CA5).
 *
 *   npm test
 */
import assert from "node:assert/strict"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { ejecutarTurno, type DependenciasCiclo } from "../src/agente/ciclo.ts"
import { casosConfirmados } from "../src/agente/confirmacion.ts"
import { AlmacenSesiones } from "../src/agente/sesiones.ts"
import { ErrorLlm, type AdaptadorLlm, type MensajeLlm, type OpcionesEnvio, type RespuestaLlm } from "../src/llm/adapter.ts"

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..")
let directorio = ""

before(async () => {
  directorio = await mkdtemp(join(tmpdir(), "oc-test-"))
  await cp(join(RAIZ, "fixtures"), join(directorio, "fixtures"), { recursive: true })
})
after(async () => {
  await rm(directorio, { recursive: true, force: true })
})

type Paso = (mensajes: MensajeLlm[], opciones: OpcionesEnvio) => RespuestaLlm

/** Modelo guionado: cada llamada consume el siguiente paso. Registra lo que recibió. */
class ModeloGuionado implements AdaptadorLlm {
  readonly proveedor = "guion"
  readonly modelo = "guion-1"
  readonly recibido: Array<{ mensajes: MensajeLlm[]; opciones: OpcionesEnvio }> = []
  constructor(private readonly pasos: Paso[]) {}
  async enviar(mensajes: MensajeLlm[], _h: unknown, opciones: OpcionesEnvio): Promise<RespuestaLlm> {
    this.recibido.push({ mensajes: structuredClone(mensajes), opciones })
    const paso = this.pasos.shift()
    if (!paso) throw new Error("el guion se quedó sin pasos")
    return paso(mensajes, opciones)
  }
}

const uso = { entrada: 100, salida: 20, cacheLectura: 0, cacheEscritura: 0 }
let contador = 0
const llamar = (nombre: string, entrada: unknown): Paso => () => ({
  mensaje: { rol: "asistente", bloques: [{ tipo: "llamada", id: `t${++contador}`, nombre, entrada }] },
  motivoFin: "herramientas",
  uso,
  modelo: "guion-1",
})
const responder = (texto: string): Paso => () => ({
  mensaje: { rol: "asistente", bloques: [{ tipo: "texto", texto }] },
  motivoFin: "fin",
  uso,
  modelo: "guion-1",
})

function dependencias(llm: AdaptadorLlm, extra: Partial<DependenciasCiclo> = {}): DependenciasCiclo {
  return {
    llm,
    system: "prueba",
    directorio,
    maxIteraciones: 25,
    maxTokensSesion: 1_000_000,
    presupuestoGlobal: { disponible: () => true, consumir: () => {} },
    ...extra,
  }
}

const ultimoResultado = (mensajes: MensajeLlm[]) => {
  const m = mensajes.at(-1)
  assert.equal(m?.rol, "usuario")
  const r = m.bloques.find((b) => b.tipo === "resultado")
  assert.ok(r && r.tipo === "resultado")
  return JSON.parse(r.contenido) as { ok: boolean; codigo?: string; data?: { numero_oc?: string } }
}

describe("interpretación de la confirmación", () => {
  it("autoriza solo lo pendiente y respeta negaciones y menciones", () => {
    assert.deepEqual(casosConfirmados("Confirmo", ["sol-004"]), ["sol-004"])
    assert.deepEqual(casosConfirmados("sí, créala", ["sol-004"]), ["sol-004"])
    assert.deepEqual(casosConfirmados("no la crees todavía", ["sol-004"]), [])
    assert.deepEqual(casosConfirmados("confirmo", []), [])
    assert.deepEqual(casosConfirmados("Confirmo la SOL-2026-006", ["sol-004", "sol-006"]), ["sol-006"])
    assert.deepEqual(casosConfirmados("¿qué dice la cotización?", ["sol-004"]), [])
  })
})

describe("ciclo del agente", () => {
  it("CA3: el modelo no puede confirmar por su cuenta; la confirmación del usuario sí habilita la creación", async () => {
    const sesiones = new AlmacenSesiones(directorio, 10)
    const sesion = await sesiones.obtenerOCrear("sesion-prueba-ca3")

    // Turno 1: el modelo valida y luego intenta crear con confirmado=true sin que nadie lo haya confirmado.
    const modelo = new ModeloGuionado([
      llamar("oc_validar", { caso: "sol-004" }),
      llamar("oc_crear", { caso: "sol-004", confirmado: true }),
      responder("La cotización difiere 6 %. ¿Confirmas crear la OC de sol-004?"),
    ])
    const t1 = await ejecutarTurno(sesion, "Procesa sol-004", dependencias(modelo))
    const intento = ultimoResultado(modelo.recibido[2]!.mensajes)
    assert.equal(intento.ok, false)
    assert.equal(intento.codigo, "CONFIRMACION_NO_HUMANA")
    assert.equal(t1.needsConfirmation, true)
    assert.deepEqual(t1.casosPendientes, ["sol-004"])
    assert.equal(t1.toolCalls.length, 2)

    // Turno 2: el usuario confirma; el backend adjunta la nota y la herramienta acepta.
    const modelo2 = new ModeloGuionado([llamar("oc_crear", { caso: "sol-004", confirmado: true }), responder("OC creada.")])
    const t2 = await ejecutarTurno(sesion, "Confirmo", dependencias(modelo2))
    const notaEnviada = modelo2.recibido[0]!.mensajes.at(-1)
    assert.ok(notaEnviada?.bloques.some((b) => b.tipo === "texto" && b.texto.includes("CONFIRMÓ explícitamente: sol-004")))
    const creada = ultimoResultado(modelo2.recibido[1]!.mensajes)
    assert.equal(creada.ok, true)
    assert.match(creada.data?.numero_oc ?? "", /^45\d{8}$/)
    assert.equal(t2.needsConfirmation, false)
  })

  it("CA3: una confirmación vale solo para el mensaje inmediatamente siguiente", async () => {
    const sesion = await new AlmacenSesiones(directorio, 10).obtenerOCrear("sesion-prueba-ca3b")
    await ejecutarTurno(sesion, "Procesa sol-006", dependencias(new ModeloGuionado([llamar("oc_validar", { caso: "sol-006" }), responder("¿Confirmas el IVA C1?")])))
    assert.deepEqual(sesion.pendientes, ["sol-006"])
    // El usuario cambia de tema: la confirmación caduca.
    await ejecutarTurno(sesion, "¿Qué otras solicitudes hay?", dependencias(new ModeloGuionado([responder("Hay 6 solicitudes.")])))
    assert.deepEqual(sesion.pendientes, [])
    const modelo = new ModeloGuionado([llamar("oc_crear", { caso: "sol-006", confirmado: true }), responder("…")])
    await ejecutarTurno(sesion, "confirmo", dependencias(modelo))
    assert.equal(ultimoResultado(modelo.recibido[1]!.mensajes).codigo, "CONFIRMACION_NO_HUMANA")
  })

  it("CA1: al llegar al tope de iteraciones pide respuesta sin herramientas", async () => {
    const sesion = await new AlmacenSesiones(directorio, 10).obtenerOCrear("sesion-prueba-ca1")
    const modelo = new ModeloGuionado([
      llamar("oc_leer_paquete", { caso: "sol-001" }),
      llamar("oc_leer_paquete", { caso: "sol-002" }),
      responder("Alcancé el tope: leí sol-001 y sol-002; falta validar."),
    ])
    const r = await ejecutarTurno(sesion, "Procesa todo", dependencias(modelo, { maxIteraciones: 2 }))
    assert.equal(modelo.recibido[2]!.opciones.permitirHerramientas, false)
    assert.equal(r.iteraciones, 3)
    assert.match(r.reply, /tope/)
  })

  it("CA5: un error del proveedor se informa en claro y la sesión sigue viva", async () => {
    const sesion = await new AlmacenSesiones(directorio, 10).obtenerOCrear("sesion-prueba-ca5")
    const falla: Paso = () => {
      throw new ErrorLlm("El modelo tardó demasiado en responder (timeout).", true)
    }
    const r = await ejecutarTurno(sesion, "Procesa sol-001", dependencias(new ModeloGuionado([llamar("oc_leer_paquete", { caso: "sol-001" }), falla])))
    assert.match(r.error ?? "", /timeout/)
    const r2 = await ejecutarTurno(sesion, "¿Sigues ahí?", dependencias(new ModeloGuionado([responder("Sí.")])))
    assert.equal(r2.error, null)
    assert.equal(r2.reply, "Sí.")
  })
})
