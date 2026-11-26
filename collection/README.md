# Colección Postman de la API de Sequentia

Las superficies que aceptan **API key**: la REST bajo `/api/v1`, incluido el carril agéntico, y un ejemplo del servidor MCP. Se importa, se rellenan tres variables y corre contra tu workspace.

Es una **copia vendorada** del artefacto que genera la plataforma (ver [PUBLISHING.md](PUBLISHING.md)) y el mismo que usa el CLI de este repo como **catálogo ejecutable**. Trae seis carpetas:

| Carpeta | Qué tiene | ¿La ejecuta el CLI? |
| :--- | :--- | :--- |
| `System` | `Health`, sin credencial | sí |
| `Knowledge Bases` | lectura de KBs y artículos, búsqueda léxica, `Analytics summary` y `Knowledge gaps` | sí |
| `Agent API` | el carril agéntico: `Retrieve`, `Verify`, `Query`, `Feedback`, `Report a knowledge gap`, `Record an agent decision`, `Index status` | sí |
| `Ingest (iPaaS)` | crear un borrador, buscar artículos, listar KBs | sí |
| `Bulk article edits` | ediciones en lote de hasta 200 artículos de una KB: renombrar, mover de categoría, deprecar | sí |
| `MCP` | el handshake de MCP y tres `tools/call` de ejemplo, contra `{{mcpUrl}}` | **no**: es otro transporte y el CLI lo cubre por su carril propio |

Lo que sigue sobre escrituras, créditos y scopes habla de las cinco carpetas REST, que son las que el CLI ejecuta. `node sq-test.mjs api list` imprime ese catálogo con los nombres exactos.

## Puesta en marcha

**1. Importar** los dos ficheros de esta carpeta:

- `sequentia-api.postman_collection.json`
- `sequentia.postman_environment.json`

**2. Rellenar tres variables** en el entorno *Sequentia — celda*:

| Variable | Qué va dentro |
| :--- | :--- |
| `baseUrl` | El origen **directo de tu celda**, algo como `https://tu-celda.example`. Sin barra final y **sin `/api/v1`**: cada petición ya lleva la ruta completa. No es el host del servidor MCP, que suele ser otro. |
| `apiKey` | Una key `sk_live_…`. Está tipada como *secret*, lo que **la enmascara en la interfaz y nada más**. Guardala como valor **current**, o en Postman Vault — **nunca como *initial***. El *initial* se sincroniza con el workspace, así que en un workspace **público** se publica: es la forma más fácil de regalar una credencial sin darse cuenta. Un valor *shared* o *initial* también sale en cualquier exportación del entorno. |
| `kbId` | Corré *Knowledge Bases → List knowledge bases* y copiá un `id`. La consola te imprime el primero. |

El default de `baseUrl` es **inalcanzable a propósito** (`.invalid`, reservado por RFC 2606). La razón no es cosmética: un default que resolviera es uno que alguien puede dejar puesto mientras su key `sk_live_…` viaja hacia él como bearer token en cada petición.

**3. Probar `System → Health` primero.** No necesita key, así que un fallo ahí señala `baseUrl` y no la credencial. Cualquier otro orden hace que un token malo y un host mal copiado se vean igual.

## Antes de darle a «Run folder»

En las carpetas REST, **siete peticiones escriben** en tu workspace y no hay ninguna que limpie:

| Petición | Qué deja |
| :--- | :--- |
| `Agent API → Report a knowledge gap` | una fila de hueco de conocimiento en la cola de triage |
| `Agent API → Feedback` | una fila de feedback de utilidad en la analítica de la KB |
| `Agent API → Record an agent decision` | una fila `agent.decision_recorded` en la auditoría del workspace y, si la decisión es `escalated`, una escalada en Measure results |
| **`Ingest (iPaaS) → Create a draft article`** | **un artículo BORRADOR en la KB** — sin publicar, pero contenido real que alguien tiene que borrar. Es el único endpoint público que **crea** contenido |
| **`Bulk article edits → Bulk rename articles`** | **títulos nuevos en artículos reales**, publicados incluidos (una versión por artículo) |
| **`Bulk article edits → Bulk move articles to a category`** | **artículos movidos de categoría**, todo o nada |
| **`Bulk article edits → Bulk deprecate articles`** | **artículos DEPRECADOS**: los publicados salen de búsqueda, respuestas y Help Center hasta que alguien los republique, y la API no republica |

Las tres de `Bulk article edits` traen ids de relleno que responden `404` y no escriben nada: escriben de verdad recién cuando se reemplazan por ids reales. La guarda de `--yes` del CLI las trata igual que a las demás, porque lo que decide es la metadata y no el relleno.

**Seis gastan créditos** de IA: las tres de `Agent API` —`Retrieve (bring your own LLM)`, `Verify a claim` y `Query (Sequentia synthesises)`—, `Ingest (iPaaS) → Create a draft article`, y `Bulk rename articles` y `Bulk move articles to a category`, que reindexan los publicados. `Bulk deprecate articles` escribe pero no cobra. La que sorprende es `Retrieve`: **los gasta aunque no sintetice nada**, porque embebe la consulta en cada llamada.

La carpeta `MCP` no escribe, pero sus tres `tools/call` declaran que gastan créditos: corrida desde Postman con «Run folder», también cobra.

Un caso que sorprende al revés: `Knowledge Bases → Query knowledge base (lexical)` **no gasta créditos** pese a llamarse *query* y pedir `rag.query`. Es búsqueda léxica.

Apuntá esto a un workspace que estés dispuesto a dejar marcado, o corré la carpeta `Knowledge Bases` sola, que es toda de lectura y no cobra. `Bulk article edits` no se corre con «Run folder» salvo a propósito.

## Ninguna key creada con un clic corre la colección entera

Los formularios de Admin Studio **no son superconjunto entre sí**, así que hay que elegir de dónde sale la key sabiendo qué se pierde. Los tres scopes que más se pierden:

| Petición | Necesita | Dónde se consigue |
| :--- | :--- | :--- |
| `Knowledge Bases → Analytics summary` | `analytics.read` | el formulario de APIs generales |
| `Knowledge Bases → Knowledge gaps` | `gaps.read` | el formulario de APIs generales |
| `Ingest (iPaaS) → Create a draft article` y las tres de `Bulk article edits` | `articles.write` | solo el preset iPaaS de Account Secrets |

> `gaps.read` **no** es lo mismo que `gaps.write`. Leer la cola sale del formulario de APIs generales; reportar un hueco (`gaps.write`), del de Agent Playground. Ninguno de los dos da el otro.

Y dos endpoints del carril no tienen **scope de reserva**: `Agent API → Feedback` (`agent.feedback`, que solo ofrece el formulario de Agent Playground) y `Agent API → Record an agent decision` (`agent.write_audit`). Cada uno se abre con una sola cadena, así que una key que corre todo lo demás puede fallar exactamente ahí.

## El bloque `sq-test`

Cada petición declara, dentro de su descripción, un bloque cercado legible por máquina:

~~~
```sq-test
{"scopes":["agent.retrieve","rag.query"],"persists":null,"spendsCredits":true}
```
~~~

Va en la descripción y no en un campo propio por una razón práctica: **Postman preserva las descripciones textualmente** entre importaciones y exportaciones, así que el bloque sobrevive un viaje de ida y vuelta por la interfaz. Un campo inventado no.

| Clave | Qué significa |
| :--- | :--- |
| `scopes` | Los scopes que abren la petición, en **OR**: alcanza con tener uno. Un array vacío significa que no necesita credencial. |
| `auth` | `false` solo en las que corren sin credencial. Si falta, se asume `true`. |
| `persists` | Qué deja escrito, en prosa, o `null` si no escribe nada. **Toda petición que no es `GET` lo declara**, aunque sea `null`: sin esa regla, «no escribe» sería indistinguible de «nadie lo pensó». |
| `spendsCredits` | Si consume créditos de IA. |
| `internalRead` | Si el resultado puede incluir contenido de visibilidad interna. |
| `captures` | Qué variables de colección deja escritas su script. |

## Las capturas son variables de COLECCIÓN, no de entorno

`articleId`, `retrievalId` y sus acompañantes (`…Source`, `…At` y `…Kb`: quién la escribió, cuándo y contra qué KB) viven en el ámbito de colección a propósito. Postman resuelve el entorno **antes** que la colección, así que declararlas en el entorno —aunque fuera vacías— le ganaría a la captura: `Get article` mandaría `/articles/`, que el servidor rutea al **listado**, y devolvería un `200` con la carga equivocada.

Tampoco capturan a lo bruto:

- **Solo escriben con respuesta exitosa.** El carril agéntico incluye un `retrievalId` en sus cuerpos de `402`, `500` y `502`; capturarlo de uno de esos ataría un feedback posterior a una consulta que nunca produjo respuesta.
- **`Retrieve` y `Query` guardan también cuándo y contra qué KB capturaron**, y `Feedback` **se niega a enviar** si el id falta, si tiene más de diez minutos, o si se capturó contra otra KB. Ese tercer caso es el más silencioso de los tres: consultar la KB A, cambiar `kbId` a B y calificar **funciona** —el servidor escribe la fila con lo que diga el cuerpo— y la calificación aterriza en un panel que esa recuperación nunca tocó.

Los diez minutos son política de esta colección, no del servidor.

## Diagnóstico rápido

| Síntoma | Lectura probable |
| :--- | :--- |
| Falla `System → Health` | `baseUrl` mal — no es la credencial |
| `401` en todo | La key no empieza con `sk_live_`, o no existe |
| `402` en todo el carril agéntico | Falta el módulo agéntico en el plan. Es plan, no key: ninguna la abre |
| `402` solo en las que sintetizan | Sin créditos. La credencial y el plan están bien; falta saldo |
| `403` en unas peticiones y no en otras | Scopes por petición; ninguna key de un solo formulario los cubre todos |
| `403` nombrando la knowledge base | No es un scope: es la lista blanca de KBs de la credencial |
| `404` en una KB que existe | El servidor responde igual para una KB inexistente y una de otro workspace, a propósito |
| `409` en gap-report o feedback | La misma clave de idempotencia con un cuerpo distinto, dentro de la ventana de 24 h |
| `429` | Dos techos con relojes distintos: el de la credencial y uno por IP en el borde |
| `503` con `RATE_LIMITER_UNAVAILABLE` | El limitador caído fallando cerrado. **No** te limitaron |
| `200` con `results` vacío en `Query knowledge base (lexical)` pero el Studio sí responde | Esa petición busca **artículos publicados**; el panel de Pruebas RAG busca **documentos vectorizados**. Mirá `noResultsReason`: `no_searchable_articles` en una KB documental es lo esperado. Usá `Agent API → Retrieve (bring your own LLM)` |
| `200` con `articles: []` en `List / search articles` | El parámetro `q` viene vacío, que lista todo; si le pusiste un término, es filtro, no fallo |
| `401` con una key que en otras peticiones anda | Probablemente la **ruta** no existe: bajo `/api/v1/` el middleware de auth corre antes del 404, así que un path desconocido responde `401` y no `404`. Revisá la URL antes que la credencial |
| `200` con cuerpo HTML | `baseUrl` apunta a un proxy o una landing, no a la celda |

## Cómo se mantiene

Ver [PUBLISHING.md](PUBLISHING.md). En corto: **el original lo genera la plataforma** y cada celda lo sirve en `/.well-known/`; esta carpeta es una copia vendorada que entra por PR. No se edita a mano ni en la interfaz de Postman.
