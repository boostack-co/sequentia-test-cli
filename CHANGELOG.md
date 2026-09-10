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

- **La colección quedó publicada** en un workspace público de Postman. `collection/PUBLISHING.md` registra el workspace y el id; la *access key* de lectura **no** va al repo (GitHub la bloquea por push protection y un token en repo público se rota tarde o temprano), así que `SQ_TEST_COLLECTION_URL` sigue sin default y cada quien pone la suya.

### Notas para quien actualiza

- **`SQ_TEST_API_URL` no es el endpoint MCP.** Suele ser otro host: es el origen **directo** de tu celda, sin barra final y sin `/api/v1`.
- **En el carril API, `--kb` y `--var kbId=` quieren el UUID**, no el slug. El carril MCP sí resuelve slugs contra `list_knowledge_bases`; el REST responde `404 Knowledge base not found`, que es la misma respuesta que da para una KB de otro workspace.

## [2.1.0] y anteriores

Sin entrada de changelog: este archivo empieza en 2.2.0. Las versiones `1.1.0`, `2.0.0` y `2.1.0` cubren el carril MCP y están publicadas en [npm](https://www.npmjs.com/package/sequentia-test-cli?activeTab=versions); el historial está en los commits.

[2.2.0]: https://github.com/boostack-co/sequentia-test-cli/compare/v2.1.0...HEAD
