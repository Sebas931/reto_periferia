# Reto 03 — Agente conversacional "Órdenes de Compra SAP"

Agente que lee el paquete de una solicitud de compra (correo, solicitud, cotización, aprobación y factura), aplica los controles RC1–RC10 contra los maestros, construye la OC con trazabilidad, genera la evidencia de aprobación (TXT y PDF con sha256) y la crea en un SAP simulado. Las excepciones se devuelven al humano: los bloqueos no se crean y las confirmaciones se crean solo cuando la analista confirma explícitamente.

- **Link de prueba:** `<URL pública del despliegue>`. Clave de acceso: `<ACCESS_KEY, si se configuró>`
- **Diseño y decisiones:** [SOLUCION.md](SOLUCION.md)

## Requisitos

- Node.js 20 o superior (probado con Node 22). No requiere build: TypeScript se ejecuta con `tsx`.
- Una clave de Anthropic solo para el chat. `demo.ts` y las pruebas no la necesitan.

## Levantar en local (un comando)

```bash
npm install
cp .env.example .env      # y completa ANTHROPIC_API_KEY
npm run dev               # http://localhost:3000 (front + API)
```

`npm start` hace lo mismo sin recarga automática (es el comando de producción).

## Verificación sin modelo

```bash
npm run demo     # procesa los 6 casos llamando directo a las herramientas; termina con 20/20 verificaciones
npm test         # ciclo del agente con un modelo simulado: confirmación humana, tope de iteraciones, errores
npm run typecheck
npm run modulo:check   # verifica que modulo/ coincide con la app
```

`demo.ts` limpia `out/` al inicio, procesa `sol-001` a `sol-006`, muestra `apta`, bloqueos, confirmaciones, `retroactiva` y el número de OC o el motivo. Además prueba la idempotencia (`sol-001` dos veces), rechaza un payload alterado y confirma explícitamente `sol-004` y `sol-005`.

## Variables de entorno

| Variable | Obligatoria | Default | Uso |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Para el chat | — | Clave del modelo. Solo vive en el backend. |
| `LLM_MODEL` | No | `claude-opus-5-5` | Modelo. |
| `LLM_EFFORT` | No | `medium` | Esfuerzo del modelo (`low`…`max`). |
| `LLM_MAX_TOKENS` | No | `16000` | Tope de salida por llamada. |
| `LLM_TIMEOUT_MS` | No | `120000` | Timeout por llamada al proveedor. |
| `MAX_ITERACIONES` | No | `25` | Tope de iteraciones modelo → herramienta por turno. |
| `MAX_TOKENS_SESION` | No | `600000` | Tope de tokens por sesión. |
| `MAX_TOKENS_DIA` | No | `8000000` | Tope global diario del servidor. |
| `MAX_SESIONES` | No | `200` | Sesiones en memoria. |
| `ACCESS_KEY` | No | — | Si se define, el front y la API la exigen (`x-access-key`). |
| `PORT` | No | `3000` | Puerto HTTP. |

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, casosPendientes, uso, error }` |
| `POST` | `/api/chat/stream` | Igual, como eventos SSE: `sesion`, `pensando`, `herramienta_inicio`, `herramienta_fin`, `texto`, `fin`. El front usa este. |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión: mensajes, llamadas a herramientas, confirmaciones y tokens usados. |
| `GET` | `/api/health` | `{ ok, provider, model, effort, llmConfigurado, herramientas }`, sin claves. |
| `POST` | `/api/reset` | Borra las OC y archivos generados para repetir la demo (conserva sesiones). |
| `GET` | `/out/...` | Descarga los archivos generados de una lista blanca (payload, trazabilidad, evidencia, control.csv). |

El front acepta `?sesion=<id>` para abrir una conversación existente.

## Estructura

```
agent/prompt.md                 comportamiento (system prompt)
src/knowledge/ordenes-compra.md conocimiento del proceso
src/tools/oc.ts                 herramientas zod (oc_<export>) — ejecución
src/tools/registro.ts           validación de argumentos, ejecución y log (out/log.jsonl)
src/dominio/                    lectura del paquete, controles RC1–RC10, payload, evidencia, control.csv
src/sap/adapter.ts, mock.ts     interfaz SapAdapter y SAP simulado (out/sap/)
src/llm/adapter.ts, anthropic.ts interfaz del proveedor LLM y su implementación
src/agente/                     ciclo del agente, sesiones, confirmación humana, carga del prompt
src/server.ts                   API HTTP (Hono) y front estático
web/                            chat en HTML + JS
demo.ts                         verificación sin modelo
tests/                          pruebas del ciclo con modelo simulado
modulo/                         bonus: agente empaquetado (generado con npm run modulo)
fixtures/                       entregados por Periferia (solo lectura)
out/                            generado en ejecución
```

## Despliegue

Render (incluye `render.yaml`): crea un *Blueprint* desde el repositorio, define `ANTHROPIC_API_KEY` (y opcionalmente `ACCESS_KEY`) en el panel y despliega. El health check es `/api/health`. También hay un `Dockerfile` para Railway, Fly.io o Azure Container Apps.

`out/` es efímero en esos servicios: un reinicio vacía el SAP simulado, lo cual sirve para la demo. Desde el front, **Reiniciar demo** lo vacía a demanda.
