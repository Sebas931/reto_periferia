import { z } from "zod"

const entero = (porDefecto: number) => z.coerce.number().int().positive().default(porDefecto)

const EsquemaEntorno = z.object({
  PORT: entero(3000),
  LLM_PROVIDER: z.enum(["anthropic"]).default("anthropic"),
  LLM_MODEL: z.string().min(1).default("claude-opus-5-5"),
  LLM_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  LLM_MAX_TOKENS: entero(16000),
  LLM_TIMEOUT_MS: entero(120_000),
  /** CA1: tope de iteraciones herramienta → modelo por turno. */
  MAX_ITERACIONES: entero(25),
  /** Tope de tokens (entrada + salida) por sesión. */
  MAX_TOKENS_SESION: entero(600_000),
  /** Tope global diario: protege la clave si el link público se abusa. */
  MAX_TOKENS_DIA: entero(8_000_000),
  MAX_SESIONES: entero(200),
  /** Si se define, el front y la API exigen esta clave (cabecera x-access-key). */
  ACCESS_KEY: z.string().min(1).optional(),
})

export type Config = z.infer<typeof EsquemaEntorno> & { tieneClaveLlm: boolean }

export function leerConfig(entorno: NodeJS.ProcessEnv = process.env): Config {
  const limpio = Object.fromEntries(Object.entries(entorno).filter(([, v]) => v !== ""))
  const r = EsquemaEntorno.safeParse(limpio)
  if (!r.success) {
    throw new Error(`Configuración inválida: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`)
  }
  return { ...r.data, tieneClaveLlm: Boolean(entorno.ANTHROPIC_API_KEY) }
}
