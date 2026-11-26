# De dónde sale esta colección y cómo se mantiene

**El original lo genera la plataforma desde sus propios routers. Lo que hay en esta carpeta es una copia vendorada.**

Esa frase es toda la política, y **es la inversa de la que este documento decía antes**. Vale la pena registrar por qué cambió, porque el razonamiento anterior no era malo: era correcto mientras no existiera la alternativa.

## Qué cambió y por qué

Hasta 2026-09-11 la colección se escribía **a mano en este repo** y se publicaba a Postman. El argumento era bueno —revisión por PR, historia junto al código que la consume, e independencia de un servicio de terceros— y funcionó: correrla contra celdas de verdad encontró defectos reales.

Lo que lo volvió obsoleto es que **la plataforma empezó a generar la suya desde los routers**, que son la verdad. Mantener las dos era sostener dos descripciones de la misma API, en dos repos, derivando por separado. Lo delató un detalle: las dos habían convergido, sin saberlo, en el mismo modelo de metadatos por petición — `scopes`, `persists`, `spendsCredits`, `internalRead`. Cuando dos equipos resuelven el mismo problema y llegan al mismo vocabulario, suele ser que el artefacto debía ser uno.

Lo que **no** cambió es la independencia: el CLI sigue **empaquetando** su copia. Una celda caída no lo deja sin catálogo.

## De dónde viene

Cada celda sirve, sin credencial, la colección con la que fue construida:

```http
GET <origen de tu celda>/.well-known/postman-collection.json
GET <origen de tu celda>/.well-known/postman-environment.json
```

El artefacto y el servidor son **el mismo build**, así que no pueden desincronizarse. Por eso `api collection --check` **deriva la URL de `SQ_TEST_API_URL`** en vez de traer un default fijo: contrastar contra una celda ajena compararía contra un contrato que no es el que uno va a llamar. `SQ_TEST_COLLECTION_URL` sigue existiendo para pisar el origen —un fork, una celda de pruebas— y nada más.

No hay ninguna coordenada de celda en este repo, y el job `secretos` del CI lo hace cumplir.

## El ciclo de vida de un cambio

1. Cambia un endpoint, o hay uno nuevo → **el cambio es del lado de la plataforma**, en el catálogo de su generador.
2. Se despliega la celda.
3. **Se vendora acá**: se bajan los dos ficheros de `/.well-known/` y entran por PR.
4. `sq-test api collection --check` en verde.

**Un cambio no está entregado hasta el paso 4.** Y el paso 3 sigue siendo un PR a propósito: es lo que conserva la revisión y la historia que motivaban el modelo anterior. Lo que se revisa ahora es un diff **generado**, no uno escrito a mano — más fácil de leer, y sin la posibilidad de que alguien invente una ruta.

## Revendorar para un release

Desde la raíz del repo, en una rama nueva desde `dev`:

```bash
curl -fsS <origen de la celda>/.well-known/postman-collection.json  -o collection/sequentia-api.postman_collection.json
curl -fsS <origen de la celda>/.well-known/postman-environment.json -o collection/sequentia.postman_environment.json
node collection-lint.mjs && node collection-sync-smoke.mjs
SQ_TEST_API_URL=<origen de la celda> node sq-test.mjs api collection --check
node sq-test.mjs api list | tail -1
```

- `--check` tiene que decir que no hay deriva: es la prueba de que lo empaquetado es lo que sirve la celda.
- La última línea de `api list` (cuántas peticiones, cuántas escriben, cuántas gastan créditos) va al PR y, si cambió, a `## [Sin publicar]` del CHANGELOG junto con qué peticiones entraron o salieron. Si cambiaron nombres de peticiones, carpetas o scopes, `collection/README.md` se ajusta en el mismo PR.
- El PR describe el cambio en términos de peticiones y carpetas, nunca con el origen de la celda: ese va como `<origen de la celda>` también en la salida que se pega.

Publicar la colección en un workspace público de Postman no es parte de este repo ni de su release.

## Qué NO se hace

**No se edita esta carpeta a mano.** Un arreglo escrito acá lo pisa el siguiente vendorado, en silencio. Si una petición está mal descrita, el arreglo va al catálogo del generador, en el repo de la plataforma.

**No se edita en Postman.** Una copia en Postman es una superficie de lectura. Lo que se cambie ahí no vuelve a esta carpeta, y si alguien la usa como origen de `--check` aparece como deriva.

## Lo que este CLI no ejecuta

La colección canónica trae también la carpeta **MCP**, y está bien que la traiga: para una persona en Postman es lo único que hace ese protocolo tocable a mano — la carpeta arrastra el `mcp-session-id` entre llamadas, que es la parte difícil.

Este CLI **la salta**. MCP no es otra ruta sino otro transporte —JSON-RPC sobre otro host, con sesión y SSE— y su carril propio ya lo cubre con cliente, menú y comandos que no leen esta colección. El descarte sale del campo `transport` del bloque `sq-test`, y ocurre **antes** de validar: una petición de otro transporte no cumple ni tiene por qué cumplir las reglas del carril REST, y validarla primero abortaría la carga entera.

**Consecuencia que conviene conocer:** un cambio que solo toque la carpeta MCP **no lo ve `--check`**, porque el comparador trabaja sobre el catálogo y el catálogo la excluye. Es un punto ciego conocido, no un descuido.

## Agregar una petición

Va en el catálogo del generador, del lado de la plataforma. Lo que este CLI le exige a cada entrada, y que **rompe la carga entera** si falta:

1. **Un bloque `sq-test`** en la descripción, con sus `scopes`, `persists` —aunque sea `null`— y `spendsCredits`. Una petición que no es `GET` y no declara `persists` no carga, y esa regla existe para que «no escribe» no pueda confundirse con «nadie lo pensó».
2. **Host `{{baseUrl}}` y ruta bajo `/api/v1`**, salvo que declare otro `transport`.
3. **Ninguna variable reservada** (`baseUrl`, `apiKey`): las resuelve el cliente desde la config del usuario, no la colección.
