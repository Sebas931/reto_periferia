// Front de chat del agente OC. HTML + JS plano, sin build.
const $ = (sel) => document.querySelector(sel)
const mensajes = $("#mensajes")
const form = $("#form")
const texto = $("#texto")
const btnEnviar = $("#btn-enviar")

const almacen = {
  leer(clave) {
    try { return localStorage.getItem(clave) } catch { return null }
  },
  escribir(clave, valor) {
    try { valor === null ? localStorage.removeItem(clave) : localStorage.setItem(clave, valor) } catch {}
  },
}

// ?sesion=<id> abre una sesión existente (útil para revisar una conversación en la defensa).
let sessionId = new URLSearchParams(location.search).get("sesion") ?? almacen.leer("oc.sessionId")
let claveAcceso = almacen.leer("oc.accessKey")
let ocupado = false

// ── Utilidades ──────────────────────────────────────────────────────────

const cabeceras = () => ({ "content-type": "application/json", ...(claveAcceso ? { "x-access-key": claveAcceso } : {}) })
const conClave = (url) => (claveAcceso ? `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(claveAcceso)}` : url)

function escapar(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

/** Markdown seguro (marked + DOMPurify); si las librerías no cargaron, texto plano. */
function markdown(t) {
  if (window.marked && window.DOMPurify) return window.DOMPurify.sanitize(window.marked.parse(t, { gfm: true, breaks: true }))
  return `<p style="white-space:pre-wrap">${escapar(t)}</p>`
}

/** Convierte rutas out/... del texto en enlaces descargables. */
function enlazarRutas(nodo) {
  const patron = /\bout\/(sol-\d{3}\/(?:payload\.json|trazabilidad\.json|aprobacion\.txt|aprobacion\.pdf|oc\.json)|control\.csv|sap\/ordenes\.jsonl)\b/g
  const recorrido = document.createTreeWalker(nodo, NodeFilter.SHOW_TEXT)
  const textos = []
  while (recorrido.nextNode()) textos.push(recorrido.currentNode)
  for (const t of textos) {
    if (!patron.test(t.nodeValue) || t.parentElement.closest("a")) continue
    patron.lastIndex = 0
    const span = document.createElement("span")
    span.innerHTML = escapar(t.nodeValue).replace(patron, (m) => `<a href="${conClave("/" + m)}" target="_blank" rel="noopener">${m}</a>`)
    t.replaceWith(span)
  }
}

function alFinal() {
  mensajes.scrollTop = mensajes.scrollHeight
}

function quitarBienvenida() {
  mensajes.querySelector(".bienvenida")?.remove()
}

// ── Render ──────────────────────────────────────────────────────────────

function agregarUsuario(t) {
  quitarBienvenida()
  const div = document.createElement("div")
  div.className = "msg usuario"
  div.textContent = t
  mensajes.append(div)
  alFinal()
}

function agregarAsistente(t, { necesitaConfirmacion = false, casosPendientes = [], activo = false } = {}) {
  quitarBienvenida()
  const div = document.createElement("div")
  div.className = `msg asistente${necesitaConfirmacion ? " confirmacion" : ""}`
  div.innerHTML = markdown(t || "_(sin texto)_")
  enlazarRutas(div)
  if (necesitaConfirmacion) {
    const banner = document.createElement("div")
    banner.className = "banner-confirmacion"
    banner.innerHTML = `<span>⚠ El agente espera tu confirmación: ${casosPendientes.map(escapar).join(", ")}</span>`
    if (activo) {
      const botones = document.createElement("div")
      botones.className = "botones"
      const si = Object.assign(document.createElement("button"), { type: "button", className: "si", textContent: "Confirmo, crear OC" })
      const no = Object.assign(document.createElement("button"), { type: "button", className: "no", textContent: "No crear" })
      si.onclick = () => enviar(`Confirmo, crea la OC de ${casosPendientes.join(" y ")}.`)
      no.onclick = () => enviar(`No, no crees la OC de ${casosPendientes.join(" ni ")} por ahora.`)
      botones.append(si, no)
      banner.append(botones)
    }
    div.append(banner)
  }
  mensajes.append(div)
  alFinal()
}

function agregarError(t) {
  const div = document.createElement("div")
  div.className = "msg error"
  div.textContent = t
  mensajes.append(div)
  alFinal()
}

/** Tarjeta de llamada a herramienta: nombre, argumentos y resultado (colapsable). */
function tarjetaHerramienta({ id, nombre, argumentos }) {
  quitarBienvenida()
  const det = document.createElement("details")
  det.className = "herramienta"
  det.dataset.id = id
  det.innerHTML = `
    <summary><span class="nombre">🔧 ${escapar(nombre)}</span><span class="resumen">${escapar(JSON.stringify(argumentos ?? {}))}</span><span class="estado">ejecutando…</span></summary>
    <div class="etiqueta">Argumentos</div><pre>${escapar(JSON.stringify(argumentos ?? {}, null, 2))}</pre>
    <div class="etiqueta">Resultado</div><pre class="resultado">…</pre>`
  mensajes.append(det)
  alFinal()
  return det
}

function completarHerramienta(det, { ok, resumen, resultado }) {
  let codigo = null
  let bonito = resultado
  try {
    const p = JSON.parse(resultado)
    codigo = p.codigo ?? null
    bonito = JSON.stringify(p, null, 2)
  } catch {}
  const espera = !ok && (codigo === "REQUIERE_CONFIRMACION" || codigo === "CONFIRMACION_NO_HUMANA")
  det.classList.add(ok ? "ok" : espera ? "espera" : "falla")
  det.querySelector(".estado").textContent = ok ? "✓ ok" : espera ? "⏸ requiere confirmación" : "✗ error"
  det.querySelector(".resumen").textContent = resumen
  det.querySelector(".resultado").textContent = bonito
}

function pensando(mostrar, etiqueta = "Pensando") {
  mensajes.querySelector(".pensando")?.remove()
  if (!mostrar) return
  const div = document.createElement("div")
  div.className = "pensando"
  div.innerHTML = `<span class="puntos"><span></span><span></span><span></span></span>${escapar(etiqueta)}…`
  mensajes.append(div)
  alFinal()
}

function desactivarConfirmacionesPrevias() {
  mensajes.querySelectorAll(".banner-confirmacion .botones").forEach((b) => b.remove())
}

// ── Envío con streaming SSE ─────────────────────────────────────────────

async function enviar(mensaje) {
  if (ocupado || !mensaje.trim()) return
  ocupado = true
  btnEnviar.disabled = true
  desactivarConfirmacionesPrevias()
  agregarUsuario(mensaje)
  pensando(true)
  const tarjetas = new Map()

  try {
    const resp = await fetch("/api/chat/stream", {
      method: "POST",
      headers: cabeceras(),
      body: JSON.stringify({ ...(sessionId ? { sessionId } : {}), message: mensaje }),
    })
    if (resp.status === 401) {
      pedirClave(true)
      throw new Error("Clave de acceso inválida. Vuelve a intentarlo.")
    }
    if (!resp.ok || !resp.body) {
      const cuerpo = await resp.json().catch(() => ({}))
      throw new Error(cuerpo.error ?? `Error ${resp.status}`)
    }

    const lector = resp.body.getReader()
    const decodificador = new TextDecoder()
    let buffer = ""
    while (true) {
      const { value, done } = await lector.read()
      if (done) break
      buffer += decodificador.decode(value, { stream: true })
      const eventos = buffer.split("\n\n")
      buffer = eventos.pop() ?? ""
      for (const bloque of eventos) procesarEvento(bloque, tarjetas)
    }
  } catch (e) {
    pensando(false)
    agregarError(e.message || "No se pudo contactar al servidor.")
  } finally {
    pensando(false)
    ocupado = false
    btnEnviar.disabled = false
    texto.focus()
  }
}

function procesarEvento(bloque, tarjetas) {
  const evento = bloque.match(/^event: (.*)$/m)?.[1]
  const datos = bloque.match(/^data: (.*)$/m)?.[1]
  if (!evento || !datos) return
  const d = JSON.parse(datos)
  switch (evento) {
    case "sesion":
      sessionId = d.sessionId
      almacen.escribir("oc.sessionId", sessionId)
      break
    case "pensando":
      pensando(true, d.iteracion === 0 ? "Pensando" : "Analizando resultados")
      break
    case "herramienta_inicio":
      pensando(false)
      tarjetas.set(d.id, tarjetaHerramienta(d))
      pensando(true, `Ejecutando ${d.nombre}`)
      break
    case "herramienta_fin": {
      const det = tarjetas.get(d.id) ?? tarjetaHerramienta(d)
      completarHerramienta(det, d)
      break
    }
    case "fin":
      pensando(false)
      if (d.reply) agregarAsistente(d.reply, { necesitaConfirmacion: d.needsConfirmation, casosPendientes: d.casosPendientes, activo: true })
      if (d.error) agregarError(d.error)
      break
  }
}

// ── Historial al recargar ───────────────────────────────────────────────

async function restaurar() {
  if (!sessionId) return
  const resp = await fetch(conClave(`/api/sessions/${encodeURIComponent(sessionId)}`), { headers: cabeceras() }).catch(() => null)
  if (!resp?.ok) return
  const s = await resp.json()
  const ultimaAsistente = s.transcripcion.findLastIndex((e) => e.tipo === "asistente")
  s.transcripcion.forEach((e, i) => {
    if (e.tipo === "usuario") agregarUsuario(e.texto)
    if (e.tipo === "herramienta") completarHerramienta(tarjetaHerramienta(e), e)
    if (e.tipo === "error") agregarError(e.texto)
    if (e.tipo === "asistente") {
      const activo = i === ultimaAsistente && i === s.transcripcion.length - 1
      agregarAsistente(e.texto, { necesitaConfirmacion: e.necesitaConfirmacion, casosPendientes: e.casosPendientes, activo })
    }
  })
}

// ── Estado del backend y acciones ───────────────────────────────────────

function pedirClave(forzar = false) {
  if (claveAcceso && !forzar) return
  const valor = window.prompt("Este agente está protegido. Ingresa la clave de acceso (está en el README):")
  claveAcceso = valor?.trim() || null
  almacen.escribir("oc.accessKey", claveAcceso)
  document.querySelectorAll("a[data-protegido]").forEach((a) => (a.href = conClave(a.getAttribute("href").split("?")[0])))
}

async function salud() {
  const chip = $("#modelo")
  try {
    const h = await (await fetch("/api/health")).json()
    chip.textContent = `${h.provider} · ${h.model}`
    if (!h.llmConfigurado) {
      chip.classList.add("apagado")
      chip.title = "El backend no tiene clave del modelo configurada"
    }
    if (h.requiereClave) pedirClave()
  } catch {
    chip.textContent = "backend no disponible"
    chip.classList.add("apagado")
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault()
  const t = texto.value
  texto.value = ""
  enviar(t)
})

texto.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault()
    form.requestSubmit()
  }
})

document.querySelectorAll("#sugerencias button").forEach((b) => b.addEventListener("click", () => enviar(b.dataset.msg)))

$("#btn-nueva").addEventListener("click", () => {
  sessionId = null
  almacen.escribir("oc.sessionId", null)
  mensajes.innerHTML = '<div class="bienvenida"><h2>Nueva sesión</h2><p>¿Qué solicitud procesamos?</p></div>'
})

$("#btn-reset").addEventListener("click", async () => {
  if (!window.confirm("¿Borrar las OC creadas y los archivos generados (out/) para repetir la demo?")) return
  const r = await fetch("/api/reset", { method: "POST", headers: cabeceras() })
  if (r.ok) agregarAsistente("**Demo reiniciada.** El SAP simulado y los archivos de `out/` quedaron vacíos.")
  else agregarError("No se pudo reiniciar la demo.")
})

await salud()
await restaurar()
texto.focus()
