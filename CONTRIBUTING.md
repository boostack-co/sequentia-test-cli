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
npm install -g .     # deja el comando `sq-mcp`
sq-mcp init          # crea ~/.config/sq-mcp/.env
```

## Cómo verificar un cambio

No hay CI: la verificación es correr el código contra un servidor real. Como mínimo, antes de abrir el PR:

```bash
# el menú, guionado (cada argumento es una respuesta)
node menu-smoke.mjs 1 1 "" b q
node menu-smoke.mjs 1 2 1 "una pregunta" fast 2 "" b q

# el CLI
node sq-mcp.mjs tools
node sq-mcp.mjs list-kbs --json | jq .

# y los casos que deben FALLAR, que son los que prueban el diseño
node sq-mcp.mjs verify-claim --kb <kb> --claim x            # exit 2, se niega
node sq-mcp.mjs query-kb --kb <kb> --q hola --mdo precise   # exit 2, flag desconocido
node sq-mcp.mjs list-categories --kb 00000000-0000-0000-0000-000000000000  # exit 1
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

## Pull requests

1. Forkeá el repo y creá una rama desde `main`.
2. Abrí el PR **contra `main`** — es la rama por defecto, así que tu fork ya apunta ahí.
3. El CI corre solo. No necesita credenciales: valida sintaxis, y que los casos negativos devuelvan el exit code correcto usando una API key falsa.
4. Un maintainer revisa y aprueba. `main` y `dev` no aceptan pushes directos.

`dev` es la rama de integración del equipo; no hace falta que la uses.

Sobre el PR en sí:

- Un PR = una intención. Decí **qué cambia, por qué, y qué verificar**.
- Incluí la **salida real** de tu verificación, no la que esperabas. No hay CI que pruebe contra un servidor real: tu verificación es la prueba.
- Si encontraste el bug usando la herramienta, pegá el comando que imprimió: es exactamente la información que hace falta para reproducirlo.

## Licencia

Al contribuir, aceptás que tu aporte se licencia bajo la [Apache License 2.0](LICENSE), igual que el resto del proyecto.
