# Test de Integraciones SEQUENTIA

[![CI](https://github.com/boostack-co/sequentia-test-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/boostack-co/sequentia-test-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sequentia-test-cli)](https://www.npmjs.com/package/sequentia-test-cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Probá las capacidades de integración de [Sequentia](https://sequentia.co) desde la terminal, en minutos. Cubre **MCP** completo, y el **carril API** (`/api/v1`) ya corre cualquier petición de su colección.

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

`sq-test init` crea `~/.config/sq-test/.env`. Editalo y poné tu API key de Sequentia en `SQ_TEST_TOKEN`; si vas a usar el carril API, poné también `SQ_TEST_API_URL`. Después, desde cualquier directorio:

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

La raíz tiene siete secciones:

```
   0. Configuración
   1. MCP                     13 funcionalidades
   2. API · lectura            3 acciones
   3. API · carril agéntico    6 acciones
   4. Agente                   2 acciones
   5. Diagnóstico              1 acción
   6. Colección                2 acciones
```

Dentro de `1. MCP` están las 12 herramientas más `tools`, numeradas `1.1`…`1.13`; desde la raíz se puede saltar directo escribiendo `1.4` — y lo mismo vale para cualquier sección, así que `3.4` entra directo al estado del índice. **El nombre del comando también sirve de atajo**: tipear `retrieve` o `doctor` desde la raíz hace lo mismo que su número, que es lo que deja crecer la lista sin volverla un muro. **Esos números son contrato público** —están acá y en los guiones de `menu-smoke.mjs`, que son literalmente secuencias de números—, así que se agregan **al final**: una herramienta nueva toma el `1.14`, un ítem nuevo va al final de su sección y una sección nueva al final de la raíz. Nunca se reasigna ni se reordena un número ya publicado. El CI afirma los 13 de MCP y los 14 del carril API, y se lo vio rechazar un ítem intercalado, una sección intercalada y dos secciones intercambiadas — mientras que agregar al final lo deja en verde, que es el único cambio que el diseño permite. La knowledge base se elige de una lista: no hay que tipear UUIDs. **Esa lista se pide al servidor cada vez que se abre el selector**, así que una KB creada con el menú abierto aparece enseguida.

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

## El carril API (`/api/v1`)

El otro frente de integración de Sequentia: la REST que acepta API key. Entra por sesiones; hoy están el cliente, el ejecutor genérico y los atajos del carril agéntico.

| Comando | Qué hace |
| :--- | :--- |
| `api health` | Comprueba que la celda responde. **No usa credencial.** |
| `api list` | Lista lo que declara la colección: scopes, qué escribe y qué cuesta. Tampoco usa credencial ni red. |
| `api run '<nombre>'` | Corre cualquier petición de la colección. `[--var clave=valor] [--yes]` |
| `api retrieve` | Recupera fragmentos con procedencia, sin generar nada. `--kb --q [--max-results 1-50] --yes` |
| `api query` | El carril gestionado: Sequentia sintetiza. `--kbs a,b --q [--max-results 1-20] --yes` |
| `api verify` | Juzga si una afirmación está fundamentada. `--kb --claim --yes` |
| `api index-status` | Cuánto de la KB está indexado. `--kb` |
| `api gap-report` | Reporta que la KB no cubre algo. `--kb --q [--priority] --yes` |
| `api feedback` | Califica una recuperación que un humano ya leyó. `--kb --rating --yes` |
| `api doctor` | Perfila la credencial: qué scopes tiene, cuáles no, y dónde se consigue lo que falta. |
| `api collection --check` | Contrasta la colección empaquetada con la publicada en Postman. `[--refresh]` |
| `api loop` | El bucle: recuperar → generar con **tu** modelo → verificar → decidir. `--kb '<pregunta>'` |

```bash
node sq-test.mjs api health
node sq-test.mjs api list
node sq-test.mjs api run 'List knowledge bases' --json | jq
node sq-test.mjs api run 'Get knowledge base' --var kbId=<uuid>
```

### El ejecutor genérico

`api run` es al carril REST lo que `call <tool>` es al MCP: **la colección son datos**, así que agregar un endpoint no requiere tocar el CLI. El nombre se puede dar completo (`Agent API / 1. Retrieve`), solo el de la petición (`1. Retrieve`) o como fragmento; si coincide con varias, **no elige por vos** — las enumera. En un banco de pruebas correr otra cosa de la que se pidió invalida el experimento, y acá hay peticiones que escriben.

Tres guardas corren **antes de cualquier red**:

- **`--yes` sale de la metadata de la petición**, no de una lista mantenida a mano. Una petición nueva que persiste o gasta créditos **nace protegida**.
- **Una variable sin resolver es un error de uso.** Sin eso, un `{{kbId}}` viaja como texto literal dentro de la ruta y lo que devuelve el servidor se lee como un fallo suyo.
- **`baseUrl` y `apiKey` no se pueden pasar con `--var`.** El host sale de `SQ_TEST_API_URL` y el token de `SQ_TEST_TOKEN`; que no puedan venir de otro lado es lo que impide que una colección —o un comando pegado— mande tu API key a un servidor ajeno.

**Son dos endpoints distintos, y ahí empiezan casi todos los problemas.** El de MCP (`SQ_TEST_URL`) suele ser el gateway universal, el mismo para todos. La API REST la sirve **tu celda**, así que `SQ_TEST_API_URL` es un host propio y no tiene default: un valor por defecto acá sería un host ajeno recibiendo tu API key como bearer token en cada petición.

Se acepta **con y sin `/api/v1`**. No es una comodidad: cada ruta ya empieza con ese prefijo, así que pegar el base URL en la forma en que suele aparecer documentado daba `/api/v1/api/v1/…`, un 404 que se lee como un problema del despliegue y es de configuración.

### Los atajos del carril agéntico

`api run` ya puede correr estos seis endpoints. Los atajos existen por lo que el ejecutor genérico no puede dar: **convertir un 400 del servidor en un mensaje entendible sin salir a la red**, y encadenar `retrieve → feedback`.

```bash
node sq-test.mjs api retrieve --kb <slug> --q "¿cómo restablezco la contraseña?" --yes
node sq-test.mjs api feedback --kb <slug> --rating helpful --yes   # usa el id recordado
node sq-test.mjs api index-status --kb <slug>                      # ni escribe ni cuesta: no pide --yes
```

**Los contratos se parecen y no son iguales**, y equivocarse es un 400:

| | knowledge bases | tope |
| :--- | :--- | :--- |
| `api query` | `--kbs a,b` — **array** de 1 a 10, sin repetidos | `--max-results` 1–**20** |
| `api retrieve` | `--kb` — una sola | `--max-results` 1–**50** |
| `api verify` | `--kb` — una sola | `--claim` ≤ 4000 caracteres |

Por eso son dos flags distintos: pasarle `--kb` a `api query` no se corrige en silencio, se rechaza explicando que ese endpoint toma un array. Que la asimetría se vea en el comando es más barato que descubrirla en un 400.

**El `retrievalId` se recuerda, y con fecha de vencimiento.** `api retrieve` lo guarda en `~/.config/sq-test/estado.json` (nunca el token) junto con **contra qué KB y contra qué celda** se capturó, para que `api feedback` no tenga que repetirlo. Se guarda **solo con una respuesta exitosa**: este carril también devuelve un `retrievalId` en los cuerpos de 402, 500 y 502, y atarle un feedback lo ligaría a una consulta que nunca produjo respuesta.

`api feedback` se niega en cuatro casos, y los cuatro terminan en una fila escrita que nadie podría interpretar después:

- **no hay ningún id recordado** — el campo es opcional en el esquema del servidor, así que un vacío se aceptaría y escribiría una fila ligada a nada, sesgando en silencio la analítica de utilidad;
- **el id tiene más de diez minutos** — política de este CLI, no del servidor;
- **se capturó contra otra KB** — el servidor escribiría la fila igual, y la calificación aterrizaría en un panel que esa recuperación nunca tocó;
- **se capturó contra otra celda** — un id de otra celda no identifica nada acá.

Las cuatro se saltan pasando `--retrieval-id <id>` explícito: ahí quien lo escribe se hace cargo.

**La clave de idempotencia se deriva del cuerpo entero** (`x-idempotency-key`, en `gap-report` y `feedback`). El requisito es que cubra exactamente lo mismo que el cuerpo, y derivarla de él lo cumple por construcción: reintentar lo mismo deduplica, y mandar algo distinto es otra observación. Una clave más estrecha devolvería 409 durante 24 h ante un cambio legítimo; una más ancha suprimiría observaciones que el contador del servidor cuenta.
### `api doctor` — perfilar la credencial antes del 403

Es lo que ni la colección ni un ejemplo dan por su cuenta: los dos te dejan ver que algo falla; ninguno dice **por qué**, y las causas que comparten status mandan a rotar keys que estaban bien.

```bash
node sq-test.mjs api doctor
node sq-test.mjs api doctor --json | jq '.scopes'
```

Reporta el estado de cada scope en **tres** valores, y el tercero no es relleno:

| | qué significa |
| :--- | :--- |
| `✔ confirmado` | una petición gratuita respondió 2xx |
| `✘ ausente` | una petición gratuita respondió 403, y la deducción pudo nombrar cuál faltaba |
| `· sin sondear` | **no se probó**, y el informe dice por qué |

**Solo sondea lo que la colección declara sin escrituras y sin créditos**, y lo dice antes de empezar. Un diagnóstico que factura no es un diagnóstico. El conjunto sale de la metadata, no de una lista: un endpoint gratuito nuevo entra solo, y uno que cobra no se sondea nunca por descuido. El precio es que cinco de los `agent.*` quedan sin sondear, y el informe lo declara en vez de darlos por ausentes — decir que falta un permiso que quizá ya está manda a pedirlo de nuevo.

**El `kbId` sale de la lista que la propia key devuelve.** Eso quita del medio la ambigüedad más cara del 403: contra una KB que la key acaba de enumerar, un 403 ya no puede ser «esa KB no está en tu lista blanca».

**Deduce por resta cuando una petición pide dos scopes.** `GET /agent/index-status/:kbId` necesita `agent.index_status` **y** `kb.read`; si el segundo ya se confirmó por su cuenta, el informe nombra el primero en vez de acusar a los dos. Si no puede decidir, dice que hay dos candidatos — no elige.

**Distingue las tres cosas que se confunden**, y que tienen remedios distintos:

| | qué está pasando |
| :--- | :--- |
| `403` | falta un scope — la key y el plan están bien |
| `402 MODULE_NOT_ENTITLED` | el plan no incluye el módulo agéntico: **pedir más scopes no lo arregla** |
| `402` sin créditos | la key y los permisos están bien; lo que falta es saldo |
| `402` workspace | suspendido o forzando SSO: la key es válida y lo cerrado es el workspace |
| `401` | la key no fue aceptada, y entonces **no se puede afirmar nada de sus scopes** |

Y dice **dónde se consigue lo que falta**: las pantallas de creación de keys **no son superconjunto entre sí**, así que ninguna key creada desde una sola las abre todas — `gaps.read` y `kb.read_internal` no figuran en ninguna, y se conceden por la API de creación de keys.

**Antes de eso dice si hace falta conseguirlo, que es la pregunta anterior.** La colección declara los scopes de cada petición **en OR** —alcanza con tener uno—, así que el informe cruza los que faltan o quedaron sin sondear contra los confirmados:

```
· agent.retrieve   solo se alcanza por "Agent API / 1. Retrieve", que gasta créditos · pero rag.query abre esas peticiones igual: no hace falta
```

Esa línea es la diferencia entre pedir un permiso y darse cuenta de que ya se tiene el equivalente. Los `agent.*` que cobran son a la vez los que **nunca** se pueden sondear y los que tienen una alternativa más amplia, así que sin ella el informe deja abierta justo la pregunta que se hace quien los mira. Y solo aparece con la alternativa **confirmada**: tranquilizar de más manda a no pedir lo que sí se necesita, que es el defecto opuesto y no es mejor.

Las alternativas salen del catálogo empaquetado, no de una tabla escrita a mano — este repo es público e independiente, y una tabla de provisioning acá se desactualizaría en silencio.

> **Sobre `kb.read_internal`**, el informe avisa en vez de reforzar el error habitual: gobierna un puñado de peticiones y **no es una frontera de confidencialidad general**. Lo que acota lo que una key alcanza es su lista blanca de KBs más un filtro de audiencia que falla cerrado. Provisionar una key creyendo que negar ese scope oculta el contenido interno es el error que este comando existe para no cometer.

Sale con `0` aunque falten scopes — **el informe es el resultado**, y una key incompleta no es un fallo del comando. Solo sale con `3` si la celda no responde, porque ahí no hubo diagnóstico.

### `api loop` — el bucle gobernado

**Recuperar → generar con tu modelo → verificar → decidir.** No es un tutorial del flujo, que es obvio: es el flujo con las decisiones difíciles tomadas, y lo que enseña es **dónde está la frontera de responsabilidad**. Sequentia recupera y verifica; el modelo y la decisión son tuyos.

```bash
export SQ_TEST_LLM_URL=http://localhost:11434/v1/chat/completions
export SQ_TEST_LLM_MODEL=llama3.1

node sq-test.mjs api loop --kb <slug> "¿cómo restablezco la contraseña?"
node sq-test.mjs api loop --kb <slug> --no-generate "…"     # sin modelo, sin escribir
node sq-test.mjs api loop --kb <slug> --json "…" | jq       # un solo valor JSON
```

El modelo es **tuyo**: este CLI no trae ninguno. El shape es el `/chat/completions` de OpenAI, que cubre vLLM, Ollama, LM Studio, OpenRouter y OpenAI directo tal cual. **Azure queda afuera a propósito** — necesita `endpoint`, `apiVersion` y `deployment`, y fingir que anda sería peor que decir que no está.

Se pide `temperature: 0`, porque el bucle decide sobre lo que el modelo escribió y una corrida que no se puede repetir no se puede auditar. Los **modelos de razonamiento lo rechazan** con un `400` —la familia `o*` de OpenAI, y desde `gpt-5.5` también la principal—, así que si el servidor lo rechaza se reintenta una vez sin el parámetro. El precio no se paga en silencio: el paso `generar` de la traza lleva `temperatura: null` y la narración dice `SIN temperature:0, no reproducible`. El reintento pide **dos** condiciones, un `400` **y** que el mensaje nombre el parámetro: un `400` por otra cosa —un modelo que no existe, un cuerpo mal formado— se reporta tal cual, en vez de gastar una segunda llamada para volver a fallar igual con el motivo real tapado.

**Sin framework de agentes**, y no por ascetismo: un framework resuelve selección no determinista de herramientas, y este bucle es lineal y fijo, así que no habría nada que orquestar. Lo caro de acá —los contratos, la política, la traza— ningún framework lo trae, y un framework lo esconde.

#### Una sola cifra de política

`--max-send-risk`, 0.5 por defecto. **Todo lo demás se deriva de la respuesta del servidor**: `supported` con riesgo bajo manda, `unsupported` escala, y `contradicted` escala **siempre** sin mirar el riesgo — que la KB contradiga lo que el modelo escribió no es incertidumbre, es un desacuerdo.

Si la verificación no trae ni `riskScore` ni `confidence`, **escala y lo dice**. Asumir riesgo cero mandaría una respuesta que nadie evaluó.

#### Un tipo no basta cuando de un número sale una decisión

```
riskScore: false  ->  Number(false) === 0  ->  riesgo mínimo  ->  MANDAR
riskScore: -5     ->  -5 <= 0.5            ->                     MANDAR
```

Las dos pasan cualquier comprobación laxa y las dos mandan. Se cierra con un **predicado** —número real, finito, dentro del rango que el servidor promete— y no con un `typeof`.

#### Contratos de respuesta: `requires` contra `accepts`

La distinción **es** el diseño:

- **`requires`** — el campo cuya **ausencia hace que el default del llamante engañe**. Sin `chunks`, la recuperación se lee como vacía, o sea la rama de sin-evidencia — y esa rama archiva un hueco durable culpando a un curador por una pregunta que la KB quizá cubre. **La ausencia es el defecto.**
- **`accepts`** — el campo cuyo default es inocuo pero cuyo **tipo equivocado revienta**, y revienta *después* de haber anotado el paso como exitoso. **Solo el tipo es el defecto.**

Se declaran en el sitio de la llamada, no en un registro central: solo quien llama sabe qué campos lee, y nombrarlos ahí es lo que hace visible en un review qué necesita un endpoint nuevo.

#### Cuatro negativas antes de verificar

Hay respuestas que **no son verificables**, y mandarlas a `/verify` produce un veredicto que no habla de lo que el agente va a enviar. Ninguna de las cuatro archiva un hueco de conocimiento — **la KB no tiene la culpa de que el modelo invente una cita**:

| | por qué no alcanza con verificar |
| :--- | :--- |
| **cita fuera de rango** — un `[7]` con dos fuentes | `/verify` **no lo puede cazar**: hace su propia recuperación y juzga la afirmación, así que puede devolver `supported` sobre evidencia que el lector nunca vio |
| **ninguna cita**, y tampoco la declinación | una respuesta sin procedencia no se puede comprobar, y mandarla igual convierte al verificador en un sello de goma |
| **subrogado suelto** | `JSON.parse` los acepta, así que cualquier respuesta puede traer uno; el encoder del cuerpo lo cambia por U+FFFD y `/verify` juzgaría una afirmación que el modelo nunca hizo |
| **por encima de 4000 unidades UTF-16** | **no se trunca**: un veredicto sobre los primeros 4000 no cubre lo que el agente manda |

El tope se mide en **unidades UTF-16**, no en puntos de código: un par subrogado son dos. Y se mide **exactamente lo que se envía** —el texto ya recortado con `String.prototype.trim`—, porque medir una cosa y mandar otra es la trampa: las definiciones de «espacio en blanco» no coinciden entre runtimes y la diferencia alcanza para dejar pasar algo que el servidor rechaza.

#### Escapado: tres superficies que no se defienden con lo mismo

- **Caracteres de control**, porque una terminal *actúa* sobre algunos. `ESC [ 2 K` borra la línea entera: metido en un fragmento de la KB, puede borrar la línea de escalado y dejar un `DECISION: MANDAR` falso en su lugar. Se escapan a su forma visible, no se quitan.
- **La respuesta del modelo, como bloque citado con prefijo.** Una falsificación de la línea de decisión es **texto imprimible corriente**, así que escapar controles no la toca; lo único que la contiene es el prefijo, que le quita la columna donde esa línea significaría algo. Se suma a que el progreso va por stderr y la decisión por stdout: `grep '^DECISION'` sobre stdout devuelve una sola línea, la real.
- **El comando copiable**, que tiene **dos requisitos en direcciones opuestas**: seguro de *ejecutar* (hay que citar, porque `;` y `$(…)` son texto imprimible) y seguro de *copiar* (un carácter de control sobrevive al citado y después hay que escaparlo, con lo que el comando pegado llevaría un id **distinto**). No hay orden de las dos operaciones que arregle ambas, así que un valor que no puede ser las dos cosas **se declina** y una línea dice cuál se rechazó. Un comando que no reproduce la acción es peor que ninguno.

#### `--json` siempre escribe un documento

Toda salida alcanzable emite un valor, y siempre del **mismo tipo**: un array. Una corrida que muere antes de anotar un paso emite `[]` — falta `--kb`, falta `SQ_TEST_LLM_URL`, la pregunta llegó en blanco: todas escriben el documento y salen con `2`. Cero bytes es indistinguible de un proceso que se murió, y quien parsea la salida no debería tener que escribir dos caminos según el desenlace: para eso está el exit code.

El límite está donde el bucle todavía no existe. Una **invocación** que el parseo rechaza —una opción desconocida, un posicional de más— falla antes de llegar al comando y reporta solo por stderr, igual que en cualquier otro comando del CLI: ahí no hay corrida de la que emitir traza. Un script que redirige `--json` a `jq` no se topa con eso salvo que tenga mal escrita la línea, que es un error suyo y no un desenlace del bucle.

#### Modos y salida

| | |
| :--- | :--- |
| `--no-generate` | para tras recuperar: mirar scopes y procedencia sin modelo y **sin escribir nada** |
| `--managed` | contrasta con `/agent/query`. **Se niega** por encima de 20 en vez de recortar: los dos carriles tienen topes distintos y recortar en silencio compararía dos cosas diferentes |
| `--show-evidence` | muestra la evidencia de verificación, **oculta por defecto** porque `/verify` recupera a visibilidad interna sea cual sea el alcance de la key |
| `--json` | la traza, que es un **array** en todos los caminos — quien la parsea no debería escribir dos formas según el desenlace |

El progreso va a stderr y la decisión a stdout, así que `api loop … > decision.txt` guarda la decisión y no los pasos.

**Exit codes:** `0` mandar · `1` escalar, o una llamada que no se sostuvo · `2` rechazada antes de empezar. Ese `2` es literal: la config del modelo se comprueba **antes** de la primera llamada, porque `/agent/retrieve` gasta créditos y una corrida que no puede terminar no debería gastarlos primero.

### La colección Postman

En [`collection/`](collection/) vive la colección pública de la API, con su entorno. Es el mismo artefacto que un cliente importa para tocar la API en cinco minutos sin escribir código, y el que el CLI usa como **catálogo ejecutable**: `api run` corre cualquier petición que la colección declare.

Cada petición lleva en su descripción un bloque `sq-test` legible por máquina con sus scopes, qué persiste y si gasta créditos — que es lo que después alimenta la guarda de `--yes`. Ver [`collection/README.md`](collection/README.md) para usarla y [`collection/PUBLISHING.md`](collection/PUBLISHING.md) para mantenerla.

**El original vive acá y lo de Postman es una copia.** `api collection --check` es lo que hace cumplir esa regla: trae la publicada y reporta la deriva **en los dos sentidos** — lo que está acá y no allá (falta republicar) y lo que está allá y no acá (alguien editó en la interfaz de Postman). Sale con `1` si hay deriva, así que puede romper un pipeline.

**La colección está publicada** en [este workspace público](https://www.postman.com/egonzalez-834a9dbf-7945626/sequentia-api). Para contrastar contra ella hace falta una *access key* de lectura propia en `SQ_TEST_COLLECTION_URL` — no viene por default a propósito: es un token, y un token en un repo público es algo que alguien rota algún día. Cómo se saca está en [`collection/PUBLISHING.md`](collection/PUBLISHING.md).

Compara contra **el checkout en el que estás parado**, no contra `main`: en una rama atrasada va a reportar deriva que no es real. Es lo correcto —contrasta lo que ESE árbol empaqueta— pero conviene saberlo antes de asustarse.

```bash
node sq-test.mjs api collection --check      # necesita SQ_TEST_COLLECTION_URL
node sq-test.mjs api collection --refresh    # además guarda lo traído en ~/.config/sq-test/
```

Compara el **catálogo**, no el JSON crudo: Postman le agrega ids y marcas de tiempo a lo que publica, y un diff textual estaría siempre en rojo — que es la forma más común de que un control deje de controlar. Se comparan método, ruta, cuerpo, la metadata que gobierna `--yes`, la descripción y las variables de colección.

Si la access key se rota o se revoca, **lo único que se rompe es este comando**: el CLI sigue andando con la colección empaquetada. Es a propósito, y es la razón de que el original viva en el repo.

`collection-lint.mjs` corre en el CI, sin credenciales ni red, y rechaza una colección que emita una variable que nadie define, que declare una que nadie usa, que traiga un default de URL **alcanzable**, que lleve un valor en `apiKey`, o cuyo `collection/README.md` contradiga la metadata — esa última guarda existe porque la contradicción ya pasó.

**`api health` va sin autenticar a propósito**, y por eso es el primer comando a correr: si falla, el problema es la URL y no la credencial. Cualquier otro orden hace que un token malo y un host mal copiado se vean igual.

Los comandos `api` **no aceptan `--url`** —ese es el endpoint MCP— **ni `--raw`**: en REST el cuerpo *es* el payload y no hay sobre JSON-RPC que mostrar. Aceptarlos y no usarlos sería el mismo fallo silencioso que el CLI ya rechaza para los flags mal escritos.

### Qué significa cada error

La traducción de códigos es la mitad del valor del carril, porque varias causas distintas comparten status y el remedio de cada una es otro:

| Código | Se distingue entre |
| :--- | :--- |
| `401` | falta la cabecera · el formato de la key no es `sk_live_…` · la key no existe |
| `402` | el plan no incluye el módulo agéntico · **no hay créditos** · el workspace está suspendido |
| `403` | falta un scope · la KB no está en la lista blanca de la key |
| `404` | una KB inexistente y una de otro workspace **contestan igual**, a propósito |
| `409` | la clave de idempotencia se usó antes con otro cuerpo (ventana de 24 h) |
| `429` | dos techos con relojes distintos: el de la credencial y uno por IP en el borde |
| `503` | el limitador caído fallando cerrado — **no** es que te hayan limitado |

Y un caso que no es un código: un **`200` cuyo cuerpo no es JSON** se rechaza en vez de devolverse crudo. Suele significar que la URL no es la de la celda —un proxy o una landing contestando por ella—, y devolver el texto haría que el error apareciera mucho después disfrazado de «el servidor no trae el campo X».

### Opciones globales

| Opción | Efecto |
| :--- | :--- |
| `--url <url>` | Endpoint MCP. Default `https://mcp.sequentia.co/mcp`; solo hace falta contra un despliegue propio. |
| `--api-url <url>` | Origen directo de la celda para el carril API. Sin default. Solo lo aceptan los comandos `api`. |
| `--token <tok>` | API key; pisa la del `.env`. |
| `--json` | Payload des-anidado en JSON, apto para `jq`. |
| `--raw` | Sobre JSON-RPC completo, para depurar el transporte. |
| `--verbose`, `-v` | Sesión, `serverInfo` y rate limit por **stderr**. Nunca imprime el token. |
| `--yes` | Confirma las herramientas con efectos secundarios. |

Los booleanos (`--json`, `--raw`, `--verbose`, `--yes`) no toman valor: se usan solos, o con `--flag=true` / `--flag=false` explícito. Cualquier otro valor se rechaza. Las opciones desconocidas y los argumentos sobrantes también: un `--mdo precise` o un `mode precise` suelto **fallan** en vez de correr con el default y hacerte creer que probaste otra cosa.

### Exit codes

`0` ok · `1` la herramienta devolvió `isError`, o `api collection --check` encontró deriva · `2` uso o configuración · `3` transporte, auth o rate limit.

El `1` es siempre lo mismo: **la operación se hizo y el resultado es negativo**. No lo usa `api doctor`, que sale con `0` aunque falten scopes — ahí el informe *es* el resultado, y una key incompleta no es un fallo del comando.

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
| `api-client.mjs` | `SequentiaApiClient` — el transporte REST: sin sesión, con la taxonomía de errores del carril API. También importable. |
| `catalog.mjs` | Lee la colección y la convierte en el catálogo que el CLI ejecuta. Es donde se descarta el host y donde se lee qué escribe cada petición. |
| `agent.mjs` | Los seis endpoints del carril agéntico por nombre: sus topes, la memoria del `retrievalId` y la clave de idempotencia. |
| `doctor.mjs` | El diagnóstico de credencial: qué sondear, cómo clasificar cada fallo y la deducción de qué scope falta. |
| `doctor-smoke.mjs` | Ejercita esa deducción con sondeos fabricados, sin red ni credencial. Corre en el CI. |
| `collection-sync.mjs` | Trae la colección publicada y la contrasta con la empaquetada. |
| `collection-lint.mjs` | Las guardas sobre la colección: variables, defaults inalcanzables, y que la prosa no contradiga la metadata. |
| `collection-sync-smoke.mjs` | Ejercita el comparador sirviendo la colección —mutada a propósito— desde `127.0.0.1`, sin Postman ni credenciales. Corre en el CI. |
| `loop.mjs` | El bucle: los contratos de respuesta, la política de riesgo y la traza. |
| `loop-smoke.mjs` | Ejercita esa política y esos contratos con respuestas fabricadas, sin red ni modelo. Corre en el CI. |
| `collection/` | La colección Postman pública y su entorno, más cómo se usa y cómo se mantiene. |
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
