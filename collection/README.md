# Colección Postman de la API de Sequentia

Las superficies que aceptan **API key**: la REST bajo `/api/v1`, incluido el carril agéntico. Se importa, se rellenan tres variables y corre contra tu workspace.

Es el mismo artefacto que usa el CLI de este repo como **catálogo ejecutable**, así que lo que leas acá es lo que el CLI ejecuta.

## Puesta en marcha

**1. Importar** los dos ficheros de esta carpeta:

- `sequentia-api.postman_collection.json`
- `sequentia.postman_environment.json`

**2. Rellenar tres variables** en el entorno *Sequentia — celda*:

| Variable | Qué va dentro |
| :--- | :--- |
| `baseUrl` | El origen **directo de tu celda**, algo como `https://f1-t1-g01-c001.sequentia.co`. Sin barra final y **sin `/api/v1`**: cada petición ya lleva la ruta completa. No es el host del servidor MCP, que suele ser otro. |
| `apiKey` | Una key `sk_live_…`. Está tipada como *secret*, lo que **la enmascara en la interfaz y nada más**: un valor guardado como *shared* o *initial* puede salir en una exportación del entorno. Guardala como valor *current*, o en Postman Vault. |
| `kbId` | Corré *Knowledge Bases → List knowledge bases* y copiá un `id`. La consola te imprime el primero. |

El default de `baseUrl` es **inalcanzable a propósito** (`.invalid`, reservado por RFC 2606). La razón no es cosmética: un default que resolviera es uno que alguien puede dejar puesto mientras su key `sk_live_…` viaja hacia él como bearer token en cada petición.

**3. Probar `System → Health` primero.** No necesita key, así que un fallo ahí señala `baseUrl` y no la credencial. Cualquier otro orden hace que un token malo y un host mal copiado se vean igual.

## Antes de darle a «Run folder»

**Dos peticiones escriben en tu workspace** y no hay ninguna que limpie:

| Petición | Qué deja |
| :--- | :--- |
| `Agent API → 5. Gap report` | una fila de hueco de conocimiento en la cola de triage |
| `Agent API → 6. Feedback` | una fila de feedback de utilidad en la analítica de la KB |

**Tres gastan créditos de IA:** `Agent API → 1. Retrieve`, `2. Verify` y `3. Query`. La que sorprende es la primera: **`Retrieve` los gasta aunque no sintetice nada**, porque embebe la consulta en cada llamada.

Un caso que sorprende al revés: `Knowledge Bases → Query knowledge base` **no gasta créditos** pese a llamarse *query* y pedir `rag.query`. Es búsqueda léxica.

Apuntá esto a un workspace que estés dispuesto a dejar marcado, o corré la carpeta `Knowledge Bases` sola, que es toda de lectura.

## Ninguna key creada con un clic corre la colección entera

Los formularios de Admin Studio **no son superconjunto entre sí**, así que hay que elegir de dónde sale la key sabiendo qué se pierde. Y hay un scope que no se concede desde ninguna parte de la interfaz:

| Petición | Necesita | Dónde se consigue |
| :--- | :--- | :--- |
| `Analytics *` | `analytics.read` | el formulario de APIs generales |
| `Knowledge gaps` y `gaps — stats` | `gaps.read` | **en ninguna parte de la interfaz** — solo creando la key por API |

> `gaps.read` **no** es lo mismo que `gaps.write`. Escribir un hueco es clicable; leer la cola, no.

Y `Agent API → 6. Feedback` es el único endpoint del carril **sin scope de reserva**: `agent.feedback` es la única cadena que lo abre. Una key que corre todo lo demás puede fallar exactamente ahí.

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

`articleId`, `retrievalId` y sus dos acompañantes viven en el ámbito de colección a propósito. Postman resuelve el entorno **antes** que la colección, así que declararlas en el entorno —aunque fuera vacías— le ganaría a la captura: `Get article` mandaría `/articles/`, que el servidor rutea al **listado**, y devolvería un `200` con la carga equivocada.

Tampoco capturan a lo bruto:

- **Solo escriben con respuesta exitosa.** El carril agéntico incluye un `retrievalId` en sus cuerpos de `402`, `500` y `502`; capturarlo de uno de esos ataría un feedback posterior a una consulta que nunca produjo respuesta.
- **`Retrieve` guarda también cuándo y contra qué KB capturó**, y `Feedback` **se niega a enviar** si el id falta, si tiene más de diez minutos, o si se capturó contra otra KB. Ese tercer caso es el más silencioso de los tres: consultar la KB A, cambiar `kbId` a B y calificar **funciona** —el servidor escribe la fila con lo que diga el cuerpo— y la calificación aterriza en un panel que esa recuperación nunca tocó.

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
| `200` con cuerpo HTML | `baseUrl` apunta a un proxy o una landing, no a la celda |

## Estado de verificación

**Esta colección todavía no se corrió contra una celda real.** Fija las formas de los cuerpos y las rutas según la superficie pública documentada, no que el servidor conteste lo que se espera. Correrla de verdad —a mano, o con el CLI de este repo— es lo que la convierte en algo verificado; hasta entonces, tratala como una guía bien informada.

## Cómo se mantiene

Ver [PUBLISHING.md](PUBLISHING.md). En corto: **el original vive en este repo** y lo publicado en Postman es una copia. No se edita en la interfaz de Postman.
