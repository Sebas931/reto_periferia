/**
 * CA3 / RN4: la confirmación la decide el backend a partir del texto del usuario, no el modelo.
 * Solo autoriza casos que el agente dejó pendientes en el turno inmediatamente anterior.
 */

const NEGACION = /\b(no|nunca|cancela\w*|espera|det[eé]n\w*|todav[ií]a no|a[uú]n no|rechaz\w*)\b/i
const AFIRMACION =
  /\b(s[ií]|confirm\w*|ok|okay|dale|adelante|procede\w*|autoriz\w*|apruebo|aprobad[oa]|de acuerdo|cr[eé]a\w*|hazlo|contin[uú]a\w*|listo|correcto)\b/i

/** "sol-004", "SOL-2026-004", "sol 4" → "sol-004". */
export function casosMencionados(texto: string): string[] {
  const encontrados = new Set<string>()
  for (const m of texto.matchAll(/\bsol[-\s]?(?:\d{4}-)?0*(\d{1,3})\b/gi)) {
    encontrados.add(`sol-${m[1]!.padStart(3, "0")}`)
  }
  return [...encontrados]
}

export function casosConfirmados(texto: string, pendientes: readonly string[]): string[] {
  if (!pendientes.length || NEGACION.test(texto) || !AFIRMACION.test(texto)) return []
  const mencionados = casosMencionados(texto)
  return mencionados.length ? pendientes.filter((c) => mencionados.includes(c)) : [...pendientes]
}

/** Nota del backend que acompaña el mensaje del usuario: el modelo sabe exactamente qué está autorizado. */
export function notaConfirmacion(pendientes: readonly string[], confirmados: readonly string[]): string | null {
  if (!pendientes.length) return null
  const noConfirmados = pendientes.filter((c) => !confirmados.includes(c))
  const partes: string[] = []
  if (confirmados.length) {
    partes.push(`el usuario CONFIRMÓ explícitamente: ${confirmados.join(", ")}. Puedes llamar oc_crear con confirmado=true solo para esos casos.`)
  }
  if (noConfirmados.length) {
    partes.push(`este mensaje NO confirma: ${noConfirmados.join(", ")}. No uses confirmado=true para ellos.`)
  }
  return `[Nota del sistema] ${partes.join(" ")}`
}
