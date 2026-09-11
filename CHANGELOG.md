# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/), versionado según [SemVer](https://semver.org/lang/es/).

Los **números del menú son contrato público**: se agregan al final y no se reasignan. Renumerar uno sería un cambio mayor, y hasta hoy no pasó.

## [2.2.0] — sin publicar

Agrega el **carril agéntico de la API REST** (`/api/v1`) junto al de MCP, que sigue igual. Es `minor` y no `major` porque no se renombró ningún comando ni se movió ningún número de menú.

### Agregado

- **`api health`** — comprueba que la celda responde. Va **sin credencial** a propósito: si falla, el problema es `SQ_TEST_API_URL` y no la key, y esa distinción es lo que ahorra la primera hora de diagnóstico.
- **`api list` / `api run`** — ejecutor genérico sobre la colección Postman, que viaja **empaquetada** en vez de bajarse en runtime: una key revocada o una caída de Postman no dejan al CLI sin catálogo. La guarda de confirmación sale de la metadata de cada petición, así que una petición nueva que escribe o cuesta **nace protegida**, sin que nadie tenga que acordarse de agregarla a una lista.
- **Seis atajos agénticos** — `api retrieve`, `api verify`, `api query`, `api index-status`, `api gap-report` y `api feedback`, con los topes del servidor espejados del lado del cliente: `/retrieve` topa en 50 resultados y `/query` en 20, `/query` toma un array de 1 a 10 KBs únicas y `/retrieve` una sola, y `claimText` acepta hasta 4000 unidades UTF-16.
- **Encadenado `retrieve` → `feedback`** — el `retrievalId` se recuerda por 10 minutos y **solo se captura con 2xx**: viene también en cuerpos de 402 y 502, y atarle un feedback lo ligaría a una consulta que no produjo respuesta. Sin id recordado, `api feedback` se niega: el campo es opcional en el esquema del servidor, así que un vacío se aceptaría y escribiría una fila ligada a nada.
- **`api loop`** — el bucle gobernado: Sequentia recupera y verifica, **tu** modelo genera, y la decisión sale de una sola cifra de política (`--max-send-risk`, por defecto 0.5). `contradicted` escala siempre, sin mirar el riesgo: no es incertidumbre, es un desacuerdo entre la KB y lo que el modelo escribió. Sirve cualquier `/chat/completions` compatible con OpenAI — vLLM, Ollama, LM Studio, OpenRouter u OpenAI directo. **Azure no entra en este shape**: necesita endpoint, apiVersion y deployment.
- **`api doctor`** — perfila la credencial sondeando **solo endpoints que no cobran ni escriben**, y lo dice: un diagnóstico que factura no es un diagnóstico. Distingue falta de scope de plan sin el módulo agéntico y de workspace suspendido, y un scope que ningún sondeo gratis ejercita sale como «el sondeo no concluyó» y **no** como ausente.
- **`api collection --check`** — caza la deriva entre la colección empaquetada y la publicada comparando el **catálogo**, no el JSON crudo: Postman agrega `_postman_id`, `uid`, `owner` y marcas de tiempo, así que un diff textual estaría siempre en rojo, que es la forma más común de que un control deje de controlar.
- **`collection-sync-smoke.mjs`** — cubre el comparador en el CI, que hasta ahora no lo cubría nadie: `collection-lint` valida la *forma* de la colección empaquetada, no la *comparación*. Sirve la colección mutada desde `127.0.0.1`, así que no necesita Postman ni credenciales. Incluye el control en la dirección contraria —el ruido que Postman agrega (`uid`, `_postman_id`, `owner`, `updatedAt`, el sobre `{collection}`) **no** es deriva—, que es la afirmación que justifica comparar el catálogo y no el JSON crudo.
- **`CHANGELOG.md`**, este archivo.

### Corregido

- **`api loop --json` emitía cero bytes cuando el bucle se rechazaba antes de empezar** (#29). La traza se declaraba junto a la primera llamada, así que un rechazo anterior —falta `--kb`, falta `SQ_TEST_LLM_URL`, la pregunta en blanco— salía por el manejador global sin pasar por el emisor. Cero bytes es indistinguible de un proceso que se murió, y rompía el `| jq` que `--json` promete. Ahora todo camino alcanzable emite un array, y el que muere antes de anotar un paso emite `[]`.
- **El rechazo de la pregunta estaba partido en dos**: `""` moría en el chequeo pre-dispatch y `"   "` adentro del handler, con salidas distintas para dos formas del mismo error.
- **`.env.example` había quedado desincronizado** de `plantillaEnv()`: le faltaban `SQ_TEST_COLLECTION_URL` y las tres `SQ_TEST_LLM_*`. Es el archivo que copia quien trabaja desde el repo, así que la divergencia se paga sola.

### Corregido en la verificación contra celdas reales

- **`System / Health (vector)` apuntaba a una ruta que no existe** y se quitó de la colección. `GET /api/v1/health/vector` devuelve `401` en las dos celdas probadas, **con credencial y sin ella** — igual que cualquier ruta inventada bajo `/api/v1/`, porque el middleware de auth corre antes del 404. O sea que el `401` era un artefacto de ruteo y no un problema de credencial, y la descripción publicada («Estado del almacenamiento vectorial… Tampoco lleva credencial») mandaba a quien la corriera a revisar exactamente el lado equivocado. `System / Health` sí anda y es la que hay que correr primero.
- **`temperature: 0` dejaba afuera a los modelos de razonamiento.** El bucle lo pedía siempre y no había flag ni variable que lo pisara, así que `gpt-5.5` y la familia `o*` de OpenAI —que responden `400 Only the default (1) value is supported`— simplemente no se podían usar. Ahora se reintenta una vez sin el parámetro, y la traza anota `temperatura: null` para que quien audite sepa que esa corrida no es repetible.

- **`api doctor` mandaba a una vía que no existe.** Para un scope que no figura en ningún formulario de creación de keys respondía «hay que pedirla por la vía interna». No hay tal vía: la API de creación de keys los acepta. El daño de un consejo así no es que sea inútil, es que **parece ejecutable**, así que manda a esperar una gestión con otra persona en lugar de a hacer una llamada de un minuto — en un comando cuyo trabajo es precisamente decir dónde se consigue lo que falta.
- **Y antes de eso, ahora dice si hace falta conseguirlo.** La colección declara los scopes de cada petición en OR, así que el informe cruza lo que falta contra lo confirmado: `agent.retrieve` sin sondear con `rag.query` confirmado sale como «pero rag.query abre esas peticiones igual: no hace falta». Las alternativas se derivan del catálogo empaquetado, no de una tabla escrita a mano que volvería a envejecer.
- **Un `403` sobre una petición que acepta dos scopes decía «falta alguno de».** Con semántica OR eso se lee al revés de lo que significa: no falta *alguno*, hace falta **uno**. Ahora lo dice así.

- **Un `402` de plan sin `code` se leía como workspace cerrado.** `api-client.mjs` reconocía el 402 del módulo agéntico por `code` **o** por el texto del cuerpo; `doctor.mjs` solo por `code`. Las dos lecturas habían divergido, así que el mismo `402` mandaba a mirar el plan por un lado y a hablar con administración por el otro — y la clase es lo que elige el remedio que el informe recomienda. Encontrado al escribir la primera prueba que `clasificar()` tuvo en su vida.
- **Y para que no vuelvan a divergir, ahora hay una sola lectura.** `api-client` clasifica una vez (`causaDe`) y deja la causa en `err.causa`; `doctor` la consume de ahí en vez de re-derivarla con regex sobre la prosa que el propio cliente compone.

### Corregido en la revisión de código (#41)

- **El carril REST mandaba el slug de la KB y el servidor solo entiende el UUID.** El selector del menú, los ejemplos del README y `api loop --kb <slug>` producían `404 Knowledge base not found` en cada llamada. Ahora `--kb`, `--kbs` y `--var kbId=` resuelven el slug contra `GET /knowledge-bases` —una petición que no gasta créditos— igual que el carril MCP lo hace contra `list_knowledge_bases`. El comando impreso conserva el slug.
- **El carril REST del menú ignoraba `--token` y la clave cambiada en `0.1`.** Se resolvía con `resolveApiConfig({})`, así que el carril MCP usaba la key de la sesión y el REST gastaba créditos con la del `.env`, sin que nada lo dijera. Ahora los dos carriles usan el token de la sesión, y cambiarlo invalida el cliente REST cacheado.
- **`api doctor` fijaba el veredicto de la credencial con un error transitorio.** Un 429 tras el reintento (o un 5xx, o un timeout) en **un** sondeo dejaba `Credencial: ? error` aunque los otros seis confirmaran sus scopes. Ahora ese sondeo queda «sin sondear» con un aviso, y la credencial sale `ok` si algo confirmó; si todo cae por transporte, el estado es `inconcluso` y no `sin-permisos`. Los sondeos van además por etapas de dependencia (tres viajes en vez de siete).
- **Los comandos MCP aceptaban en silencio los booleanos del carril API.** `list-kbs --managed` o `query-kb … --show-evidence` llegaban a la red sin hacer nada, y el mensaje de opción desconocida los listaba como válidos. Se rechazan con 2, como cualquier otra opción que no se usa.
- **Un `SQ_TEST_API_URL=` vacío en el `.env` del proyecto tapaba la URL del `.env` del usuario.** Los archivos se fusionan por prioridad y una clave presente pero vacía pisaba el valor real; era fácil de provocar copiando `.env.example` y llenando solo el token. Ahora solo cuentan los valores presentes.
- **Dos comandos que el menú imprimía como reproducibles no parseaban.** `api run` emitía `--var kbId abc` (una clave con espacio) y `api loop` interpolaba la pregunta entre comillas simples a mano, así que un apóstrofo dejaba una comilla sin cerrar. Los dos pasan ahora por el mismo constructor que el resto, con `--var k=v` repetido y el posicional citado.
- **`api collection --refresh` guardaba la colección remota antes de validarla**, y `--check` dejaba un temporal en `tmpdir` si la validación fallaba. Ahora el catálogo se arma en memoria —sin temporal— y la caché se escribe después de validar.
- **Cerrar una sesión MCP contra un gateway colgado tardaba 30 s por sesión.** `close()` reintentaba el DELETE tres veces con diez segundos de timeout, en serie y también ante un fallo de transporte, aunque el único caso que justifica el reintento es el 400/404 del ruteo multi-réplica. Ahora reintenta solo ante ese caso y cierra las sesiones en paralelo.
- **Un frame SSE `data: null` tumbaba la respuesta entera** con un TypeError crudo (exit 3 con stack), aunque el frame válido viniera en la línea siguiente.
- **Los errores del carril API dentro del menú perdían el detalle de transporte.** Un 401 salía como `✗ mensaje`, sin la cabecera `WWW-Authenticate` ni el cuerpo que el CLI muestra para el mismo error; y las dos cadenas de `instanceof` del carril MCP discrepaban en qué hacer con un error desconocido. Ahora una sola función (`errores.mjs`) decide qué es cada error y qué se muestra, para el CLI y para el menú.
- **`fetch failed` ya dice por qué.** Los cuatro sitios que hacían `fetch` imprimían el mensaje genérico de Node; ahora sale la causa (`ENOTFOUND`, `ECONNREFUSED`…), que es lo que distingue un host mal tipeado de un servidor apagado. Las cuatro copias de esa plomería —y la espera ante 429, que en el cliente MCP conservaba el idioma `Number(h) || 5` que el REST ya había corregido— viven en `http-comun.mjs`.
- **`AGENT_COMMANDS` y la colección declaran lo mismo por duplicado y nada lo comprobaba.** La guarda de `--yes` lee de uno para `api <atajo>` y del otro para `api run`; `agent-smoke.mjs` afirma ahora que método, ruta, scopes, `persists` y `spendsCredits` coinciden.
- **El selector de KB del menú MCP pedía `list_knowledge_bases` dos veces por acción**: una para dibujar la lista y otra para volver a mapear el slug que acababa de salir de ella.

- **La colección quedó publicada** en un workspace público de Postman. `collection/PUBLISHING.md` registra el workspace y el id; la *access key* de lectura **no** va al repo (GitHub la bloquea por push protection y un token en repo público se rota tarde o temprano), así que `SQ_TEST_COLLECTION_URL` sigue sin default y cada quien pone la suya.

### Seguridad

- **Se quitó un hostname de celda real de dos archivos que viajan en el paquete** (`collection/README.md` y el mensaje de error de `commands.mjs`). Este repo es público y sus ejemplos usan dominios reservados por RFC 2606; ese quedó de un copiado temprano. **No llegó a npm**: la `2.1.0` no lo contiene, y se corrigió antes de la `2.2.0`. **Sí llegó a GitHub**: los commits que lo introdujeron están en la rama `dev` del repo público y el historial lo conserva; quitarlo del árbol no lo des-publica. Tratarlo como expuesto es decisión del mantenedor (ver #41).
- **El job `secretos` del CI buscaba una sola forma de credencial** (`sk_live_…`), así que una access key de Postman (`access_key=…`, `PMAK-…`) o un host de celda pasaban en verde — y `PUBLISHING.md` afirmaba que el job los rechazaría. Ahora busca las tres clases.
- **`collection/README.md` refuerza el aviso de la variable `apiKey`**: va como valor *current*, nunca *initial*. El *initial* se sincroniza con el workspace, así que en un workspace **público** se publica.

- **Un query param `disabled` de Postman ahora no viaja en la petición.** El catálogo lo ignoraba, así que la misma petición hacía dos cosas distintas según se corriera desde Postman o desde el CLI — y el comando que el menú imprime dejaba de reproducir lo que Postman hace.
- **`api collection --check` ahora compara los query params.** Estaban fuera de los campos contrastados y no forman parte de `ruta`, que es solo el path: cambiar, agregar o desactivar un parámetro en Postman dejaba el chequeo en verde. Son justo lo que gobierna qué devuelve una petición.
- **`List articles` lista de verdad en la primera corrida.** Traía `?q=contraseña` activo, así que en una KB donde ese término no matchea devolvía `articles: []` y se leía como un fallo. El parámetro sigue ahí, documentado y **destildado**; la trampa que enseña —que `search=` se ignora en silencio— se prueba tildándolo.
- **`Query knowledge base (léxica)` dice sobre qué busca.** Busca **artículos**, no los documentos ingeridos, así que en una KB documental devuelve `totalFound: 0` para cualquier término mientras el panel de Pruebas RAG del Studio responde la misma pregunta. Ahora la descripción lo explica y manda al carril correcto (`Agent API → 1. Retrieve`).

### Notas para quien actualiza

- **`SQ_TEST_API_URL` no es el endpoint MCP.** Suele ser otro host: es el origen **directo** de tu celda, sin barra final y sin `/api/v1`.
- **En el carril API, `--kb`, `--kbs` y `--var kbId=` aceptan el UUID o el slug.** El servidor resuelve `knowledgeBaseId` solo por id y responde `404 Knowledge base not found` ante un slug — la misma respuesta que da para una KB de otro workspace—, así que el CLI resuelve el slug del lado del cliente antes de mandarlo.
- **Si venís de `1.x` (`sq-mcp`)**: ver la entrada de `2.0.0` abajo. El nombre del paquete no cambió, así que `npm update -g sequentia-test-cli` cruza el cambio mayor sin avisar.

## [2.1.0]

Sin entrada de changelog: el archivo empieza en 2.2.0 y las versiones anteriores están publicadas en [npm](https://www.npmjs.com/package/sequentia-test-cli?activeTab=versions); el historial está en los commits. El único cambio de esta versión que un usuario nota es que **`query-kb` sin `--mode` manda `fast` explícitamente** en vez de dejar que el servidor aplique `standard`: explorar es el uso normal y ahí la latencia importa más que la profundidad. Un script que no pasaba `--mode` obtiene respuestas más rápidas y menos profundas que antes.

## [2.0.0]

**Cambio mayor: el comando se renombró de `sq-mcp` a `sq-test`**, y con él todo lo que llevaba ese nombre. Se hizo sin capa de compatibilidad —el paquete tenía horas de publicado— y el paquete npm conserva su nombre, así que `npm update -g` lo instala sin avisar. Quien tenga `1.x`:

- El binario es `sq-test`; `sq-mcp` desaparece del PATH.
- La configuración del usuario pasa de `~/.config/sq-mcp/.env` a `~/.config/sq-test/.env`. El archivo viejo no se lee: copialo, o corré `sq-test init` y volvé a poner la key.
- Las claves pasan de `SQ_MCP_TOKEN` / `SQ_MCP_URL` a `SQ_TEST_TOKEN` / `SQ_TEST_URL`, y las variables `SQ_MCP_ENV_FILE` / `SQ_MCP_CMD` a `SQ_TEST_ENV_FILE` / `SQ_TEST_CMD`. Las viejas se ignoran en silencio.

## [1.1.0]

Primera versión publicada: el carril MCP, con el menú y el CLI.

[2.2.0]: https://github.com/boostack-co/sequentia-test-cli/compare/v2.1.0...HEAD
