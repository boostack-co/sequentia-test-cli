# Cómo se publica y se mantiene la colección

**El original vive en este repositorio. Lo que hay en Postman es una copia publicada.**

Esa frase es toda la política. El resto de este documento explica qué se sigue de ella.

## Por qué en este orden y no al revés

Postman es una superficie de **lectura para clientes**, no de edición. Poner el original allá parece más cómodo —se edita con un formulario en vez de con JSON— y cuesta las tres cosas que hacen que esto sirva:

- **Revisión.** Acá un cambio pasa por un PR, con diff y con alguien mirándolo. Una descripción que miente sobre lo que una petición escribe o cuánto cuesta hace daño a quien la corre, así que se revisa como documentación, no como configuración.
- **Historia.** Quién cambió qué y por qué, en el mismo lugar que el código que la consume.
- **Independencia.** El CLI **empaqueta** la colección en el paquete npm. Si dependiera de bajarla en tiempo de ejecución, una clave revocada o una caída de Postman lo dejaría sin catálogo.

## El ciclo de vida de un cambio

1. Cambia un endpoint, o hay uno nuevo → **PR sobre el JSON de este repo**.
2. Se fusiona.
3. **Se republica en Postman** (abajo el cómo).
4. `sq-test api collection --check` en verde.

**Un cambio no está entregado hasta el paso 4.** Los pasos 1 y 2 dejan el repo correcto y a los clientes mirando lo viejo.

## Publicar

Necesita una cuenta con permiso de escritura sobre el workspace público. Se hace a mano, y es a propósito: automatizarlo pediría meter un secreto de Postman en Actions para ahorrar un paso que se da cuando cambia la API, o sea pocas veces al año. El `--check` de la cuarta línea es lo que hace innecesaria esa automatización — **detecta la desincronización sin poder causarla**.

1. En el workspace público, abrir la colección existente e **importar el JSON encima** (*Import → Files → Replace*). No crear una colección nueva: cambiaría el id y rompería todos los enlaces publicados.
2. Importar también el entorno si cambió.
3. Comprobar que la colección publicada sigue teniendo su enlace de lectura activo.

### Qué se registra en el repo y qué no

| Dato | ¿Va al repo? |
| :--- | :--- |
| El id de la colección publicada | **Sí** — abajo |
| El workspace público donde vive | **Sí** — abajo |
| La URL de lectura **sin** la access key | **Sí** — abajo, con `<tu access key>` de marcador |
| La *access key* en sí | **No.** GitHub la bloquea por push protection, y un token en un repo público es algo que alguien rota algún día. Va en `SQ_TEST_COLLECTION_URL` de cada uno; `SQ_TEST_COLLECTION_URL` **no tiene default** |
| **La API key de Postman de quien publica** | **No, nunca.** El job `secretos` del CI la rechazaría, y con razón |

<!-- Se completan al publicar por primera vez. -->

- **Workspace público:** <https://www.postman.com/egonzalez-834a9dbf-7945626/sequentia-api>
- **Id de la colección:** `58130706-ee15e4c9-8eaa-4b98-b0fa-9ffa48ed3d73`
- **URL de lectura:** `https://api.postman.com/collections/58130706-ee15e4c9-8eaa-4b98-b0fa-9ffa48ed3d73?access_key=<tu access key>`

**La access key NO está acá, y es un cambio respecto de lo que este documento decía.** Se razonó que era publicable —es de solo lectura y de una sola colección— y en abstracto lo es, pero **GitHub la bloquea**: push protection la detecta por nombre («Postman Collection Key») y rechaza el push. Se puede desbloquear a mano, y aun así no vale la pena: un token en un repo público es algo que alguien va a rotar algún día, y ese día `--check` se rompe sin que nadie lo haya tocado. Cada quien pone la suya en `SQ_TEST_COLLECTION_URL`.

**El endpoint anónimo no sirve como reemplazo, aunque parezca que sí.** `https://www.postman.com/collections/<uid>` devuelve la colección sin credencial —el workspace es público—, pero **degrada el schema a v2.0.0**: las URL vuelven como cadena en vez del objeto `{raw, host, path}` de v2.1.0. La primera consecuencia es que `assertHostEsVariable` la rechaza; la de fondo es que comparar dos schemas distintos produciría derivas falsas. Comprobado, no deducido.

## No se edita en Postman

Si alguien lo hace, no se pierde el trabajo, pero **hay que reponerlo desde el repo**, no al revés: el original es el JSON versionado. `sq-test api collection --check` compara la publicada contra la empaquetada y reporta la deriva en los dos sentidos, así que un cambio hecho en la interfaz aparece en el siguiente chequeo.

Es el control de gobierno de todo esto: es lo único que distingue «la colección está publicada» de «lo publicado es lo que revisamos».

## Si la clave de lectura se rota o se revoca

**Lo único que se rompe es `--check`.** El CLI sigue andando con la colección que trae empaquetada, y los clientes siguen viendo la colección publicada. Eso es a propósito, y es la razón por la que el original vive acá: nada crítico depende de una credencial de un tercero que puede caducar.

Para arreglarlo: generar una clave de lectura nueva, actualizar la URL de arriba y el default del CLI, en un PR.

## Agregar una petición

Además de la petición en sí:

1. **Declarar el bloque `sq-test`** en su descripción, con sus scopes, `persists` (aunque sea `null`) y `spendsCredits`. Una petición que no es `GET` y no declara `persists` rompe el build, y esa regla existe para que «no escribe» no pueda confundirse con «nadie lo pensó».
2. Si escribe o cuesta, **decirlo en el nombre** con el prefijo `⚠` y en el README de la colección, en la tabla de lo que persiste.
3. Si necesita una variable nueva, **definirla en el entorno** — salvo que sea una captura, que va en el ámbito de colección por la razón que explica el README.
4. Comprobar que el JSON parsea y que los scripts que agregues también.
