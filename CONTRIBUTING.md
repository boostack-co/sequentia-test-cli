# Contribuir

Gracias por el interés. Esto es un banco de pruebas de las integraciones de Sequentia: se usa para ejercer el servidor MCP a mano, ver las respuestas crudas y medir cuánto tarda cada cosa.

## Antes que nada: no pegues tu token

El token (`sk_live_…`) da acceso a tu workspace. **No lo pongas en issues, PRs, capturas ni logs.** El CLI ya lo enmascara en pantalla y nunca lo incluye en los comandos que imprime; mantengamos eso.

Si creés que se filtró uno, rotalo primero y avisá después.

## Requisitos

Node >= 18. **Cero dependencias**, y es a propósito: el proyecto usa solo `fetch`, `node:readline/promises` y el resto de la biblioteca estándar. Una dependencia nueva necesita justificarse en el PR — que se instale de un tirón en cualquier máquina es parte del valor.

```bash
git clone https://github.com/<tu-usuario>/sequentia-test-cli.git
cd sequentia-test-cli
npm install -g .     # deja el comando `sq-test`
sq-test init          # crea ~/.config/sq-test/.env
```

## Cómo verificar un cambio

**Sí hay CI**, y corre sin credenciales: valida sintaxis, que la colección empaquetada no mienta, y que cada caso negativo devuelva el exit code que le toca. Eso significa que un PR desde un fork tiene CI de verdad — pero también que el CI **no prueba contra un servidor**. Esa parte sigue siendo tuya. Como mínimo, antes de abrir el PR:

```bash
# lo que el CI corre, y no necesita ni credencial ni red
node collection-lint.mjs
node collection-sync-smoke.mjs
node sq-test.mjs api list

# el menú, guionado (cada argumento es una respuesta)
node menu-smoke.mjs 1 1 "" b q
node menu-smoke.mjs 1 2 1 "una pregunta" fast 2 "" b q

# el CLI
node sq-test.mjs tools
node sq-test.mjs list-kbs --json | jq .

# y los casos que deben FALLAR, que son los que prueban el diseño
node sq-test.mjs verify-claim --kb <kb> --claim x            # exit 2, se niega
node sq-test.mjs query-kb --kb <kb> --q hola --mdo precise   # exit 2, flag desconocido
node sq-test.mjs list-categories --kb 00000000-0000-0000-0000-000000000000  # exit 1
```

`menu-smoke.mjs` sale con **1** si alguna acción falló. Un caso negativo que devuelve el exit code equivocado es un bug.

## Invariantes que no hay que romper

Estas son las promesas del proyecto. Si un cambio las toca, tiene que decirlo explícitamente en el PR:

1. **El comando impreso reproduce la acción.** El menú muestra el comando equivalente a cada cosa que hace; pegarlo en otra terminal tiene que dar lo mismo. Por eso el catálogo vive en `commands.mjs` y lo comparten el menú y el CLI: dos implementaciones del mismo comando convierten esa promesa en mentira.
2. **Nada con efectos secundarios corre sin confirmar.** `verify_claim` y `record_decision` consumen crédito y escriben en el registro de auditoría. La guarda va por **nombre de herramienta**, así que `call verify_claim …` también la exige.
3. **Una opción que se acepta, se usa.** Un flag desconocido o mal escrito se rechaza; no se ignora en silencio. En un banco de pruebas, un comando que sale con éxito habiendo hecho otra cosa invalida el experimento sin avisar.
4. **El wall-clock y la latencia del servidor son números distintos.** Se muestran separados porque la diferencia entre ambos es el costo de red y handshake. No los mezcles en uno solo.
5. **El token nunca sale por pantalla.** Ni en los comandos impresos, ni en los mensajes de error, ni en la traza de `--verbose`.
6. **`--json` emite JSON válido siempre**, también cuando el payload es texto plano. Cualquier cosa que se imprima *además* del payload (tiempos, trazas) va por `stderr`.
7. **El host nunca sale de la colección.** De la colección salen método, ruta y forma del cuerpo; `baseUrl` y el token salen **siempre** de la config del usuario, y no se pueden pasar con `--var`. Si el host viniera del documento, una colección rotada o suplantada redirigiría un `sk_live_…` a donde quisiera. `catalog.mjs` lo descarta al cargar, así que una petición que nombre su propio host **no carga**.
8. **Toda petición que escribe lo declara.** Un no-GET sin `persists` en su bloque `sq-test` —aunque sea `null`— no carga. Sin eso, «no escribe» sería indistinguible de «nadie lo pensó», y una petición nueva se publicaría sin la guarda de `--yes` que le corresponde.
9. **Los números del menú son contrato público.** Están en el README y en los guiones de `menu-smoke.mjs`, y hay gente scripteando contra ellos. Se **agregan** al final; no se renumeran ni se reordenan. Un cambio incompatible es un `feat!` y se dice en el PR.

## Pull requests

El flujo es **`tu-rama` → `dev` → `main`**, y `dev` no es opcional:

1. Forkeá el repo y creá una rama desde **`dev`**.
2. Abrí el PR **contra `dev`**. Ojo: `main` es la rama por defecto de GitHub, así que tu fork apunta ahí y el formulario de PR la propone sola — **hay que cambiarla a mano**.
3. El CI corre solo. No necesita credenciales: valida sintaxis, y que los casos negativos devuelvan el exit code correcto usando una API key falsa.
4. Un maintainer revisa y aprueba. `main` y `dev` no aceptan pushes directos.
5. La promoción **`dev` → `main`** es su propio PR, y la hace un maintainer cuando lo integrado está listo para publicarse.

**Por qué `dev` y no directo a `main`:** `main` es lo que se publica en npm. Integrar en `dev` deja que varias ramas convivan y se prueben juntas antes de que eso pase, que es justamente lo que un PR contra `main` se saltea.

> Este archivo decía antes «abrí el PR contra `main`» y «`dev` … no hace falta que la uses». Estaba mal, y no fue inocuo: la épica del carril agéntico fusionó seis PRs directo a `main` siguiendo esta misma página.

Sobre el PR en sí:

- Un PR = una intención. Decí **qué cambia, por qué, y qué verificar**.
- Incluí la **salida real** de tu verificación, no la que esperabas. El CI no toca ningún servidor: para todo lo que dependa de uno, tu verificación es la única prueba.
- Si encontraste el bug usando la herramienta, pegá el comando que imprimió: es exactamente la información que hace falta para reproducirlo.

## Licencia

Al contribuir, aceptás que tu aporte se licencia bajo la [Apache License 2.0](LICENSE), igual que el resto del proyecto.
