# Test de Integraciones SEQUENTIA

[![CI](https://github.com/boostack-co/sequentia-test-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/boostack-co/sequentia-test-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sequentia-test-cli)](https://www.npmjs.com/package/sequentia-test-cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Probá las capacidades de integración de [Sequentia](https://sequentia.co) desde la terminal, en minutos. Hoy cubre **MCP**; la **API** entra después.

```bash
npm install -g sequentia-test-cli
sq-test init          # crea ~/.config/sq-test/.env — poné ahí tu API key
sq-test               # el menú
```

Se usa de dos formas: un **menú interactivo** para explorar, y un **CLI** para scriptear. El menú imprime **el comando equivalente a cada acción y cuánto tardó**, así que se explora clickeando números y se sale sabiendo el comando exacto para automatizarlo.

Sin dependencias — solo Node ≥ 18 (`fetch` nativo). Probado en Windows, con Node 18/20/22 en CI.

## Instalación

Requiere Node >= 18.

```bash
npm install -g sequentia-test-cli
sq-test init
```

`sq-test init` crea `~/.config/sq-test/.env`. Editalo y poné tu API key de Sequentia en `SQ_TEST_TOKEN`. Después, desde cualquier directorio:

```bash
sq-test               # el menú
sq-test list-kbs      # el CLI
```

### En Windows

El shim queda en `%APPDATA%\npm\sq-test` (con sus variantes `.cmd` y `.ps1`), directorio que npm ya deja en el PATH. Si `sq-test` no resuelve, reabrí la terminal.

Para actualizar, `npm update -g sequentia-test-cli`. Para desinstalar, `npm uninstall -g sequentia-test-cli` — **el `~/.config/sq-test/.env` sobrevive**, que es justamente el motivo de que la config no viva junto al código.

### Dónde busca la configuración

Se **fusionan**, de menor a mayor prioridad, y las variables de entorno del proceso ganan sobre todas:

| Origen | Para qué |
| :--- | :--- |
| directorio de instalación `/.env` | compatibilidad con quien trabaje desde el repo |
| `~/.config/sq-test/.env` | **la config del usuario**; sobrevive a reinstalar |
| `./.env` del directorio actual | pisar valores en un proyecto puntual |
| `$SQ_TEST_ENV_FILE` | apuntar a un archivo específico |

Se fusionan en vez de tomar el primero que exista a propósito: un `.env` ajeno en el directorio actual, sin claves `SQ_TEST_*`, no debe tapar tu config y dejarte sin token. Con `--verbose`, y en el mensaje de token faltante, se listan los archivos que se leyeron.

### Desde el código (desarrollo)

```bash
git clone https://github.com/boostack-co/sequentia-test-cli.git
cd sequentia-test-cli
cp .env.example .env       # y poné tu token
node sq-test.mjs
```

Corriendo así, los comandos que imprime el menú dicen `node sq-test.mjs …` en vez de `sq-test …`: se adapta a cómo lo invocaste, para que la línea siga siendo pegable.

El `.env` **no se commitea** — el `.gitignore` lo cubre. Nunca lo agregues a la fuerza: tiene tu API key.

## El menú

`node sq-test.mjs` sin argumentos abre el menú (requiere terminal; por pipe o redirección imprime la ayuda y sale con 2, para no colgar scripts).

```
  Test de Integraciones SEQUENTIA
  mcp.sequentia.co

   0. Configuración
   1. MCP                     13 funcionalidades
   2. API                     (próximamente)

   q. Salir
```

Dentro de `1. MCP` están las 12 herramientas más `tools`, numeradas `1.1`…`1.13`; desde la raíz se puede saltar directo escribiendo `1.4`. La knowledge base se elige de una lista: no hay que tipear UUIDs. **Esa lista se pide al servidor cada vez que se abre el selector**, así que una KB creada con el menú abierto aparece enseguida.

Cada acción se enmarca entre el comando y el tiempo:

```
  $ node sq-test.mjs query-kb --kb devops-arquitectura --q 'Como monitoreo un Azure App Service' --mode fast --limit 2
  ────────────────────────────────────────────────────────────────────────
  Para monitorear un Azure App Service, …
  ────────────────────────────────────────────────────────────────────────
  2.31 s · resolver KB 165 ms · servidor: 1.96 s · cache: no · 291/300 restantes
```

Sobre esa última línea: el **wall-clock** del cliente y el `servidor:` (el `latencyMs` que devuelve el MCP) son números distintos, y la diferencia entre ambos es el costo de red y handshake. `resolver KB` se desglosa aparte porque es una llamada extra, y atribuirle ese tiempo al RAG daría una lectura falsa. El tiempo **también se imprime cuando la acción falla**: cuánto tardó en fallar es un dato.

El comando que se muestra sale de los mismos flags que ejecuta el menú, nunca incluye el token, y usa el slug de la KB en vez del UUID para que sea legible. Pegado en otra terminal, hace lo mismo. Los valores se citan con **comillas simples**: dentro de dobles, bash interactivo expande el historial y una pregunta con `!` daría `event not found` al pegarla. Un valor que empieza con `-` usa la forma `--q=-algo`, porque el parser trata a propósito un `-algo` suelto como otra opción.

Todo el recorrido usa **una sola sesión MCP**, que se cierra al salir (también con Ctrl+C).

### Verificarlo sin terminal

El menú solo arranca con TTY, y `readline` sobre un pipe lee una línea y se cuelga. Para ejercerlo de punta a punta está `menu-smoke.mjs`, que le pasa un guion de respuestas:

```bash
node menu-smoke.mjs 1 1 "" b q                                  # MCP → listar KBs → volver → salir
node menu-smoke.mjs 1 2 1 "Como monitoreo un App Service" fast 2 "" b q
node menu-smoke.mjs 0 0.4 "" b q                                # configuración → probar conexión
```

Gasta llamadas reales contra el endpoint configurado. **Sale con 1 si alguna acción falló** — el menú sigue usable tras un error, pero una corrida guionada tiene que poder distinguir una integración sana de una rota.

## Uso del CLI

```bash
node sq-test.mjs <comando> [opciones]
node sq-test.mjs --help
```

`--kb` acepta el **UUID o el slug/nombre** de la KB; si le das un slug lo resuelve solo contra `list_knowledge_bases`.

El modo de consulta por defecto es **`fast`**: el uso normal de este banco es explorar, y ahí la latencia importa más que la profundidad — la diferencia contra `standard` es de varios segundos por consulta. Se envía explícitamente, así que el comando que ves es el que corre.

| Comando | Herramienta MCP | Opciones |
| :--- | :--- | :--- |
| `list-kbs` | `list_knowledge_bases` | — |
| `query-kb` | `query_knowledge_base` | `--kb --q [--mode fast\|standard\|precise] [--language] [--limit 1-20]` · el modo por defecto es **`fast`** |
| `search` | `search_articles` | `--kb --q [--category] [--status] [--limit 1-50]` |
| `get-article` | `get_article` | `--kb` y `--id` **o** `--slug` |
| `list-categories` | `list_categories` | `--kb` |
| `verify-claim` ⚠️ | `verify_claim` | `--kb --claim [--articles a,b,c] --yes` |
| `check-freshness` | `check_freshness` | `--kb --article` |
| `canonical` | `get_canonical_answer` | `--kb --q [--language]` |
| `record-decision` ⚠️ | `record_decision` | `--decision sent\|reformulated\|escalated\|blocked [--kb] [--claim] [--verdict] [--evidence <json>] --yes` |
| `glossary` | `get_workspace_glossary` | `[--kb] [--language]` |
| `context` | `get_workspace_context` | `[--kb]` |
| `prefs` | `get_user_preferences` | — |
| `tools` | (`tools/list`) | lista lo que el servidor declara de verdad |
| `call <tool> '<json>'` | cualquiera | escotilla genérica |

⚠️ `verify-claim` y `record-decision` **consumen crédito y/o escriben en el registro de auditoría**. Exigen `--yes`; sin él el CLI se niega y sale con 2.

La guarda va por **nombre de herramienta**, no por subcomando: `call verify_claim …` y `call record_decision …` piden `--yes` igual. No hay forma de gatillar un efecto secundario sin confirmarlo.

### Opciones globales

| Opción | Efecto |
| :--- | :--- |
| `--url <url>` | Endpoint MCP. Default `https://mcp.sequentia.co/mcp`; solo hace falta contra un despliegue propio. |
| `--token <tok>` | API key; pisa la del `.env`. |
| `--json` | Payload des-anidado en JSON, apto para `jq`. |
| `--raw` | Sobre JSON-RPC completo, para depurar el transporte. |
| `--verbose`, `-v` | Sesión, `serverInfo` y rate limit por **stderr**. Nunca imprime el token. |
| `--yes` | Confirma las herramientas con efectos secundarios. |

Los booleanos (`--json`, `--raw`, `--verbose`, `--yes`) no toman valor: se usan solos, o con `--flag=true` / `--flag=false` explícito. Cualquier otro valor se rechaza. Las opciones desconocidas y los argumentos sobrantes también: un `--mdo precise` o un `mode precise` suelto **fallan** en vez de correr con el default y hacerte creer que probaste otra cosa.

### Exit codes

`0` ok · `1` la herramienta devolvió `isError` · `2` uso o configuración · `3` transporte, auth o rate limit.

Pensado para scriptear: `node.exe sq-test.mjs search --kb X --q Y --json | jq -r '.[].slug'`.

> **En Git Bash interactivo usá `node.exe`, no `node`, cuando pipees.**
> Git for Windows aliasea `node` a `winpty node.exe` en terminales mintty
> (`/etc/profile.d/aliases.sh`), y `winpty` aborta con **`stdout is not a tty`**
> apenas su salida va a un pipe en vez de a la consola. No es un problema del CLI.
> Alternativas equivalentes: `command node`, `\node`, o `unalias node` en la sesión.
> Sin pipe, `node sq-test.mjs ...` anda igual.

### Ejemplos

```bash
node sq-test.mjs tools
node sq-test.mjs query-kb --kb devops-arquitectura --q "Como monitoreo un App Service" --mode fast --limit 3
node.exe sq-test.mjs search --kb kb-privada-python --q decorators --json | jq -r '.[].slug'
node sq-test.mjs get-article --kb kb-privada-python --slug understanding-what-functions-are
node sq-test.mjs call get_workspace_glossary '{}'
```

## Cómo funciona el servidor (verificado en vivo, no según la doc)

La referencia pública de las herramientas muestra ejemplos de `tools/call` sueltos. **Esos ejemplos no funcionan** contra este deployment. Lo que hay de verdad:

1. **El servidor es stateful.** Un `tools/call` pelado devuelve
   `HTTP 400 {"code":-32000,"message":"Bad Request: Server not initialized"}`.
   Hay que hacer el handshake: `initialize` → `notifications/initialized` (responde **202**, sin body) → `tools/list` / `tools/call`.
2. **Transporte Streamable HTTP con cuerpo SSE.** `POST /mcp` responde `content-type: text/event-stream` con frames `event: message` + `data: {json}`. No sirve `res.json()`.
3. **`Accept` con los dos tipos.** `Accept: application/json, text/event-stream` — si falta cualquiera de los dos, 406.
4. **Sesión obligatoria.** El `initialize` devuelve la cabecera `mcp-session-id`; va en toda llamada posterior. Se cierra con `DELETE /mcp` (204).
5. **Auth**: `Authorization: Bearer <api key>`, con la `B` mayúscula. Sin ella, 401 + `WWW-Authenticate`.
6. **Los errores de herramienta NO son errores JSON-RPC.** Llegan como HTTP 200 con
   `{"result":{"content":[{"type":"text","text":"Error: …"}],"isError":true}}`.
   Un cliente que solo mire `response.error` los da por exitosos. Por eso `call()` chequea `isError` y el CLI sale con 1.
7. **El payload está doblemente serializado**: `result.content[0].text` es un **string JSON** que hay que volver a parsear.
8. **401/402/403/429 no son sobres JSON-RPC**: los emite la capa Express de la celda, con `{error, message}`. Un cliente que asume JSON-RPC en toda respuesta se rompe en la mayoría de los modos de falla.

### Las trampas que te van a morder

- **Máximo 5 sesiones concurrentes por credencial** → `429 {"error":"Too many active sessions"}`, **sin `Retry-After`**. Esperar no ayuda: expiran a los 30 min de inactividad. Un `curl` a mano que hace `initialize` y no hace `DELETE` **quema un slot**; cinco de esos y quedás afuera. El CLI hace `DELETE` al terminar (en un `finally`), pero un proceso matado a mano deja la sesión colgada. Para recuperar: `curl -X DELETE https://mcp.sequentia.co/mcp -H "Authorization: Bearer $TOK" -H "Mcp-Session-Id: <sid>"`.
- **Rate limits que se apilan**: ~300/min por IP en el borde y **60/min por credencial**, que cuenta *todas* las POST, incluidas `initialize` y `tools/list`. Una corrida del CLI son 3-4 POST (5 si tiene que resolver un slug de KB). El cliente reintenta una vez ante 429 de presupuesto y ante el 503 del limiter caído; ante el 429 de sesiones **no** reintenta, porque no serviría.
- **La sesión puede morir sola.** El registro de sesiones es un `Map` local al proceso de la celda, así que con varias réplicas un session id solo vale en la que lo creó. El cliente detecta `400 Server not initialized` / `404` y **rehace el handshake una vez**, en silencio.
- **Los scopes se chequean dos veces**, y no son uniformes. Puede pasar que `query_knowledge_base` ande pero **`get_canonical_answer` devuelve `Error: missing required scope 'rag.query'`**: el token tiene `kb.read` pero no `rag.query`. Es un `isError` normal (HTTP 200), no un 403.
- **`execute_action` no existe en este deployment.** La doc lista 13 herramientas; `tools/list` declara **12**. Está detrás de `ENABLE_EXTERNAL_TOOLS` + scope `agent.execute_action` y se filtra por credencial. Por eso el comando `tools` existe: te dice lo que hay de verdad, no lo que dice la doc.
- **`search_articles` cambia de forma**: normalmente devuelve un array pelado, pero si el filtro `--category` no matchea nada devuelve `{results, _warning}` — el filtro se aplica **después** del `limit`. El CLI maneja las dos formas y muestra el `_warning`.
- **`query_knowledge_base` puede responder sin error y sin respuesta**: si el workspace tiene las respuestas IA apagadas devuelve `{answer: null, aiAnswersEnabled: false, reason}` **sin** `isError`.
- **Con credencial de máquina, `--mode precise` degrada a `standard`** y lo reporta en `fallbackReason`. El CLI lo imprime.

## Archivos

| Archivo | Rol |
| :--- | :--- |
| `mcp-client.mjs` | `SequentiaMcpClient` — transporte reusable (handshake, SSE, sesión, reintentos, errores). Importable desde otros scripts. |
| `sq-test.mjs` | El CLI: flags, subcomandos, formato, exit codes. |
| `.env.example` | Plantilla de configuración. |

### Usarlo como librería

```js
import { SequentiaMcpClient } from "./mcp-client.mjs";

const client = new SequentiaMcpClient({ url: "https://mcp.sequentia.co/mcp", token: process.env.SQ_TEST_TOKEN });
try {
  const { data } = await client.call("list_knowledge_bases", {});
  console.log(data); // ya des-anidado
} finally {
  await client.close(); // importante: libera el slot de sesión
}
```

## Contribuir

Ver [CONTRIBUTING.md](CONTRIBUTING.md). En corto: cero dependencias, se verifica corriendo contra un servidor real, y hay seis invariantes que no se rompen — la principal es que **el comando que el menú imprime tiene que reproducir la acción**.

## Licencia

[Apache License 2.0](LICENSE). La licencia **no otorga derechos sobre las marcas** de Sequentia: se puede usar y forkear el código, no llamarle Sequentia a un fork.
