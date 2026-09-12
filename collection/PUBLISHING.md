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

## Qué NO se hace

**No se edita esta carpeta a mano.** Un arreglo escrito acá lo pisa el siguiente vendorado, en silencio. Si una petición está mal descrita, el arreglo va al catálogo del generador, en el repo de la plataforma.

**No se edita en Postman.** Sigue valiendo por la misma razón de siempre: es una superficie de lectura para clientes. Un cambio hecho ahí aparece en el siguiente `--check` como deriva, y se repone republicando.

## Lo que este CLI no ejecuta

La colección canónica trae también la carpeta **MCP**, y está bien que la traiga: para una persona en Postman es lo único que hace ese protocolo tocable a mano — la carpeta arrastra el `mcp-session-id` entre llamadas, que es la parte difícil.

Este CLI **la salta**. MCP no es otra ruta sino otro transporte —JSON-RPC sobre otro host, con sesión y SSE— y su carril propio ya lo cubre con cliente, menú y comandos que no leen esta colección. El descarte sale del campo `transport` del bloque `sq-test`, y ocurre **antes** de validar: una petición de otro transporte no cumple ni tiene por qué cumplir las reglas del carril REST, y validarla primero abortaría la carga entera.

**Consecuencia que conviene conocer:** un cambio que solo toque la carpeta MCP **no lo ve `--check`**, porque el comparador trabaja sobre el catálogo y el catálogo la excluye. Es un punto ciego conocido, no un descuido.

## Publicar a Postman, si se quiere

Ya no es parte del ciclo: un cliente puede importar directamente desde la URL de su celda. Si igual se quiere un workspace público como vitrina, se importa **desde esa URL**, y siguen valiendo las tres cosas que aprendimos publicando a mano:

- **El import puede crear una colección PARALELA en vez de reemplazar.** El síntoma son dos entradas con el mismo nombre, y la que conserva el `uid` publicado es la vieja — el enlace que la gente ya tiene sigue apuntando a lo desactualizado.
- **La interfaz puede ir varios minutos por detrás de la nube.** Un borrado se ve aplicado, se refresca, y vuelve.
- **Por las dos anteriores, la pantalla no sirve para dar por buena una publicación.** La API sí, y es la que lee `--check`.

## Agregar una petición

Va en el catálogo del generador, del lado de la plataforma. Lo que este CLI le exige a cada entrada, y que **rompe la carga entera** si falta:

1. **Un bloque `sq-test`** en la descripción, con sus `scopes`, `persists` —aunque sea `null`— y `spendsCredits`. Una petición que no es `GET` y no declara `persists` no carga, y esa regla existe para que «no escribe» no pueda confundirse con «nadie lo pensó».
2. **Host `{{baseUrl}}` y ruta bajo `/api/v1`**, salvo que declare otro `transport`.
3. **Ninguna variable reservada** (`baseUrl`, `apiKey`): las resuelve el cliente desde la config del usuario, no la colección.
