/**
 * Genera modulo/ (bonus 9.4) a partir de las mismas piezas que usa la aplicación,
 * para que nunca diverjan:
 *   agent/prompt.md                 → modulo/agent.md
 *   src/knowledge/ordenes-compra.md → modulo/skill/ordenes-compra/SKILL.md
 *   src/tools/oc.ts                 → modulo/tools/oc.ts (re-export, no copia)
 *
 *   npm run modulo          regenera
 *   npm run modulo:check    falla si modulo/ no coincide con la fuente
 */
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { RUTA_CONOCIMIENTO, RUTA_PROMPT } from "../src/agente/prompt.ts"
import { escribirArchivo, leerTexto } from "../src/dominio/archivos.ts"

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..")
const AVISO = "<!-- Generado por scripts/generar-modulo.ts. No editar: modificar la fuente y correr `npm run modulo`. -->"

async function piezas(): Promise<Record<string, string>> {
  const prompt = (await readFile(join(RAIZ, RUTA_PROMPT), "utf8")).trim()
  const conocimiento = (await readFile(join(RAIZ, RUTA_CONOCIMIENTO), "utf8")).trim()
  return {
    "modulo/agent.md": [
      "---",
      "description: Agente de órdenes de compra — lee el paquete de la solicitud, valida RC1–RC10 contra los maestros, construye la OC y la crea en SAP solo con controles cumplidos y confirmación humana.",
      "mode: primary",
      "permission:",
      "  edit: deny",
      "  bash: deny",
      "---",
      AVISO,
      "",
      prompt,
      "",
    ].join("\n"),
    "modulo/skill/ordenes-compra/SKILL.md": [
      "---",
      "name: ordenes-compra",
      "description: Proceso de órdenes de compra de Periferia — matriz de controles RC1–RC10, maestros, estructura de la OC en SAP y archivos de control. Úsalo al procesar solicitudes de compra.",
      "---",
      AVISO,
      "",
      conocimiento,
      "",
    ].join("\n"),
    "modulo/tools/oc.ts": [
      "/**",
      " * Herramientas del agente, importables sin el servidor HTTP.",
      " * Es un re-export de src/tools/oc.ts: el módulo y la aplicación ejecutan exactamente el mismo código.",
      " * Generado por scripts/generar-modulo.ts.",
      " */",
      'export * from "../../src/tools/oc.ts"',
      'export type { ContextoHerramienta, Herramienta } from "../../src/tools/contrato.ts"',
      "",
    ].join("\n"),
  }
}

const verificar = process.argv.includes("--check")
let divergentes = 0
for (const [ruta, contenido] of Object.entries(await piezas())) {
  const destino = join(RAIZ, ruta)
  if (verificar) {
    const actual = await leerTexto(destino)
    const igual = actual.estado === "ok" && actual.valor.replace(/\r\n/g, "\n") === contenido
    if (!igual) divergentes++
    console.log(`${igual ? "✓" : "✗"} ${ruta}`)
  } else {
    await escribirArchivo(destino, contenido)
    console.log(`escrito ${ruta}`)
  }
}
if (verificar && divergentes) {
  console.error(`${divergentes} archivo(s) de modulo/ no coinciden con la fuente. Corre: npm run modulo`)
  process.exitCode = 1
}
