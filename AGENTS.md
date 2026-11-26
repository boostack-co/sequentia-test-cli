# AGENTS.md

Guía para los agentes de código (Claude Code, Codex, Gemini CLI, Copilot u otro) que trabajan en este repo. Es la fuente única: `CLAUDE.md`, `GEMINI.md` y `.github/copilot-instructions.md` solo apuntan acá, así que una regla nueva se escribe en este archivo y en ningún otro. Sirve igual para el equipo de Sequentia que para quien lo clona y lo evoluciona por su cuenta. Lo que acá se resume vive en detalle en [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) y [collection/PUBLISHING.md](collection/PUBLISHING.md): ante una contradicción, ganan ellos.

## Este repo es público

**Todo lo que entra acá lo puede leer cualquiera, y queda para siempre**: código, docs, mensajes de commit, nombres de rama, títulos y descripciones de PR, issues, comentarios y respuestas a reviews. Un commit fusionado no se borra sin reescribir la historia, y GitHub guarda la cabeza de cada PR (`refs/pull/<n>/head`) aunque después se reescriba la rama. El historial de ediciones de una descripción también queda visible. Por eso la revisión se hace **antes** de escribir, no después.

El público de este repo son los clientes que usan el CLI y la colección. Escribí para ellos: qué hace un comando, cuándo hace falta una opción, qué significa un error. No cómo está construido el servicio por dentro.

### Lo que nunca entra

Ni en archivos, ni en commits, ni en PRs, ni en issues:

1. **Credenciales**: API keys (`sk_live_…`), tokens OAuth, keys de Postman, contenidos de un `.env`. El job `secretos` del CI rechaza algunas formas, pero no todas.
2. **Hosts y coordenadas reales de un despliegue**: el origen de una celda, su identificador o cualquier URL que no sea la pública documentada (`https://mcp.sequentia.co/mcp`). En el texto van como marcadores: `<origen de la celda>`, `<origen>/mcp`.
3. **Detalles internos del servicio**: cómo se rutean las peticiones, gateways, balanceadores, cómo se emiten o se codifican las credenciales, nombres de ambientes internos o de pruebas, proveedores de infraestructura, rutas de archivos o números de issue y PR de repos privados.
4. **Datos de un workspace**: IDs y slugs de knowledge bases, contenido de artículos, nombres de clientes o de personas, respuestas crudas copiadas de una corrida real.
5. **Identificadores de publicaciones**: UIDs de colecciones o entornos de Postman, enlaces de share. En la doc van como `<uid>`.

Si una explicación necesita alguno de esos datos para tener sentido, se reescribe en términos de lo que ve quien usa el CLI. Por ejemplo, en vez de explicar por qué una key no la acepta el endpoint por defecto, se dice «con una key que el endpoint por defecto no reconoce responde `401`; usá `--url <origen>/mcp`».

### Si algo se filtró

- **Una credencial**: rotarla primero, avisar después (SECURITY.md). Borrarla del repo no alcanza.
- **Texto que no debía estar**: avisar en el hilo de trabajo con el commit, el PR o el comentario exactos. Una descripción o un comentario se editan. Un commit fusionado en `dev` o `main` solo sale reescribiendo la rama, y eso lo decide y lo habilita un maintainer (las dos ramas bloquean el force-push). Lo que quede en `refs/pull/<n>/head` solo lo purga GitHub Support.

## Cómo se trabaja

- **Ramas y PRs**: rama desde `dev`, PR contra `dev`. `main` es lo que se publica en npm y solo recibe la promoción `dev` → `main`, que hace un maintainer. El formulario de PR propone `main` por defecto: hay que cambiarlo.
- **Cero dependencias.** Solo la biblioteca estándar de Node (≥ 18). Una dependencia nueva se justifica en el PR.
- **Las invariantes de CONTRIBUTING.md** (comando impreso que reproduce la acción, nada con efectos sin confirmar, flags desconocidos rechazados, el token nunca en pantalla, `--json` siempre válido, el host nunca sale de la colección…) no se rompen sin decirlo en el PR.
- **Los números del menú son contrato público**: se agregan al final, nunca se renumeran.
- **La colección de `collection/` es una copia vendorada**: no se edita a mano. Se actualiza bajándola de `/.well-known/` y entra por PR (PUBLISHING.md).
- **CHANGELOG**: todo cambio que llega a quien instala el paquete va en `## [Sin publicar]`.

## Verificar antes del PR

Lo que corre el CI, sin credenciales ni red:

```bash
for f in *.mjs; do node --check "$f"; done
node doctor-smoke.mjs && node commands-smoke.mjs && node agent-smoke.mjs \
  && node collection-lint.mjs && node collection-sync-smoke.mjs && node loop-smoke.mjs
```

Y el barrido de `secretos` sobre el árbol, que tiene que salir vacío (los patrones están en `.github/workflows/ci.yml`). El CI no prueba contra un servidor: lo que dependa de uno lo verificás vos, y en el PR pegás la salida real, con keys, hosts y datos del workspace sustituidos por marcadores.
