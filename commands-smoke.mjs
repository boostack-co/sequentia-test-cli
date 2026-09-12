#!/usr/bin/env node
/**
 * Ejercita las piezas compartidas de `commands.mjs` y `errores.mjs` que los
 * dos frentes dan por buenas: la fusión de `.env`, el comando reproducible, la
 * resolución de KB del carril REST y la descripción de errores.
 *
 * Cada una se rompió una vez sin que nada avisara: una clave VACÍA en un
 * `.env` de mayor prioridad tapaba la del usuario; el menú imprimía `--var
 * kbId abc` (una clave con espacio) y `loop 'what's up?'` (comilla sin
 * cerrar), dos comandos "reproducibles" que no parseaban; y el carril REST
 * mandaba el slug donde el servidor solo entiende UUID.
 *
 *   node commands-smoke.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ApiTransportError } from "./api-client.mjs";
import { UsageError, buildCommandLine, buscarKb, esUuid, resolveKbIdApi, resolverKbsDeFlags } from "./commands.mjs";
import { cargarCatalogo } from "./catalog.mjs";
import { EXIT_TOOL_ERROR, EXIT_TRANSPORT, EXIT_USAGE, describirError } from "./errores.mjs";
import { McpToolError } from "./mcp-client.mjs";

let fallos = 0;
const comprobar = async (titulo, calcular, esperado) => {
  let real;
  try {
    real = typeof calcular === "function" ? await calcular() : calcular;
  } catch (err) {
    fallos++;
    console.error(`✘ ${titulo} — lanzó: ${err?.message ?? err}`);
    return;
  }
  if (JSON.stringify(real) !== JSON.stringify(esperado)) {
    fallos++;
    console.error(`✘ ${titulo}\n    esperaba ${JSON.stringify(esperado)}\n    recibí   ${JSON.stringify(real)}`);
  } else console.log(`✔ ${titulo}`);
};

// ---------------------------------------------------------------------------
// 1. La fusión del .env: una clave presente pero VACÍA no pisa un valor.
//
// Se corre en un proceso aparte con HOME y cwd en un sandbox, porque la
// lista de candidatos la arma el módulo al importarse y el `.env` real del
// desarrollador la contaminaría. El caso es el que se dio de verdad: copiar
// `.env.example` al directorio de trabajo, llenar solo el token, y que la URL
// de `~/.config/sq-test/.env` desapareciera detrás de un `SQ_TEST_API_URL=`.
// ---------------------------------------------------------------------------
const SANDBOX = mkdtempSync(join(tmpdir(), "sq-test-commands-smoke-"));
const USUARIO = join(SANDBOX, ".config", "sq-test");
const TRABAJO = join(SANDBOX, "trabajo");
for (const d of [USUARIO, TRABAJO]) mkdirSync(d, { recursive: true });
writeFileSync(join(USUARIO, ".env"), "SQ_TEST_TOKEN=del-usuario\nSQ_TEST_API_URL=https://celda-del-usuario.invalid\n");
writeFileSync(join(TRABAJO, ".env"), "SQ_TEST_TOKEN=del-proyecto\nSQ_TEST_API_URL=\n");

const ENTORNO = { ...process.env, HOME: SANDBOX, USERPROFILE: SANDBOX };
for (const k of Object.keys(ENTORNO)) if (k.startsWith("SQ_TEST_")) delete ENTORNO[k];
// Como URL `file://`, no como ruta: en Windows un `import "D:\\…"` es un esquema `d:` inválido.
const COMMANDS = pathToFileURL(fileURLToPath(new URL("./commands.mjs", import.meta.url))).href;
const enSandbox = (codigo) => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", codigo], { cwd: TRABAJO, env: ENTORNO, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};
const leido = enSandbox(`import { loadDotenv } from ${JSON.stringify(COMMANDS)}; console.log(JSON.stringify(loadDotenv().values));`);
await comprobar("la clave llena del .env de trabajo gana (mayor prioridad)", leido.SQ_TEST_TOKEN, "del-proyecto");
await comprobar("pero la clave VACÍA no pisa la del usuario", leido.SQ_TEST_API_URL, "https://celda-del-usuario.invalid");
await comprobar(
  "y con la URL puesta en el .env del usuario, el carril API la encuentra",
  () => enSandbox(`import { resolveApiConfig } from ${JSON.stringify(COMMANDS)}; console.log(JSON.stringify(resolveApiConfig({}).apiUrl));`),
  "https://celda-del-usuario.invalid",
);
rmSync(SANDBOX, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 2. El comando reproducible. Lo que se imprime tiene que parsear.
// ---------------------------------------------------------------------------
process.env.SQ_TEST_CMD = "sq-test";
await comprobar(
  "un array se emite repitiendo la opción, en la forma clave=valor",
  () => buildCommandLine("api run", { var: ["kbId=abc", "articleId=x y"] }, { posicionales: ["Get article"] }),
  "sq-test api run 'Get article' --var kbId=abc --var 'articleId=x y'",
);
await comprobar(
  "un posicional con apóstrofo queda citado y cerrado",
  () => buildCommandLine("api loop", { kb: "devops" }, { posicionales: ["what's up?"] }),
  "sq-test api loop 'what'\\''s up?' --kb devops",
);
await comprobar("un posicional simple no lleva comillas", () => buildCommandLine("api run", {}, { posicionales: ["Health"] }), "sq-test api run Health");
// Y el CLI parsea lo que se imprimió: un --var repetido y un posicional
// citado llegan enteros. Se corre el parser de verdad, sin red.
const CLI = fileURLToPath(new URL("./sq-test.mjs", import.meta.url));
const parsea = (args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...ENTORNO, SQ_TEST_TOKEN: "x" }, encoding: "utf8" });
await comprobar(
  "`api run 'Get knowledge base' --var kbId=abc` pasa el parseo (falla recién por config)",
  () => /SQ_TEST_API_URL/.test(parsea(["api", "run", "Get knowledge base", "--var", "kbId=abc"]).stderr),
  true,
);
await comprobar(
  "el `--var kbId abc` que imprimía el menú NO parsea: sobra un argumento",
  () => /Sobran argumentos/.test(parsea(["api", "run", "Get knowledge base", "--var", "kbId", "abc"]).stderr),
  true,
);
await comprobar(
  "los booleanos del carril API no se aceptan en un comando MCP",
  () => parsea(["list-kbs", "--managed"]).status,
  EXIT_USAGE,
);
await comprobar(
  "y el mensaje ya no los lista como aceptados",
  () => /--managed/.test(parsea(["list-kbs", "--mdo", "x"]).stderr),
  false,
);

// ---------------------------------------------------------------------------
// 3. La KB del carril REST: UUID pasa tal cual; slug o nombre se resuelven
//    contra GET /knowledge-bases; lo que no existe se rechaza sin salir a
//    la red por segunda vez.
// ---------------------------------------------------------------------------
const UUID = "8772076b-f6f1-4007-aa2e-6eeee8818808";
const KBS = [{ id: UUID, slug: "devops-arquitectura", name: "DevOps" }];
let pedidas = 0;
const clienteFalso = { request: async () => ((pedidas++), { status: 200, data: { knowledgeBases: KBS } }) };
await comprobar("un UUID tiene forma de UUID", esUuid(UUID), true);
await comprobar("un slug no", esUuid("devops-arquitectura"), false);
await comprobar("buscarKb encuentra por slug sin importar la caja", () => buscarKb(KBS, "DevOps-Arquitectura")?.id, UUID);
await comprobar("y por nombre", () => buscarKb(KBS, "devops")?.id, UUID);
await comprobar("un UUID no toca la red", async () => [await resolveKbIdApi(clienteFalso, UUID), pedidas], [UUID, 0]);
await comprobar("un slug se resuelve con una petición", async () => [await resolveKbIdApi(clienteFalso, "devops-arquitectura"), pedidas], [UUID, 1]);
await comprobar(
  "una KB que no existe es un error de uso que enumera las disponibles",
  async () => {
    try {
      await resolveKbIdApi(clienteFalso, "no-existe");
      return "no lanzó";
    } catch (err) {
      return err instanceof UsageError && /devops-arquitectura/.test(err.message);
    }
  },
  true,
);
await comprobar(
  "resolverKbsDeFlags resuelve --kb y cada elemento de --kbs, y devuelve una copia",
  async () => {
    const flags = { kb: "devops", kbs: "devops, DevOps-Arquitectura", q: "hola" };
    const r = await resolverKbsDeFlags(flags, (raw) => resolveKbIdApi(clienteFalso, raw));
    return [r.kb, r.kbs, r.q, flags.kb];
  },
  [UUID, `${UUID},${UUID}`, "hola", "devops"],
);

// ---------------------------------------------------------------------------
// 4. `describirError`: la misma respuesta para el CLI y el menú.
// ---------------------------------------------------------------------------
await comprobar("un UsageError es de uso y sale 2", () => describirError(new UsageError("x")).codigo, EXIT_USAGE);
await comprobar(
  "un error de transporte trae la cabecera y el cuerpo, que es lo que el menú perdía",
  () => describirError(new ApiTransportError("Token rechazado (401)", { status: 401, wwwAuthenticate: 'Bearer realm="x"', body: "{}" })),
  { clase: "transporte", codigo: EXIT_TRANSPORT, lineas: ["transporte: Token rechazado (401)", '  WWW-Authenticate: Bearer realm="x"', "  Respuesta: {}"] },
);
await comprobar("un McpToolError sale 1", () => describirError(new McpToolError("boom", { tool: "t" })).codigo, EXIT_TOOL_ERROR);
await comprobar("un TypeError es inesperado y conserva el stack", () => {
  const d = describirError(new TypeError("boom"));
  return [d.clase, /TypeError: boom/.test(d.lineas[0]), /commands-smoke/.test(d.lineas[0])];
}, ["inesperado", true, true]);

// --- Las guardas de `api run`, con el nombre SACADO DEL CATÁLOGO -------------
//
// El CI las cubría escribiendo el nombre a mano, y al vendorar la colección
// (#48) dos casos se pudrieron sin que nada avisara, porque los dos salen con 2
// y `esperar` sólo mira el código:
//
//   api run 'Analytics'                    decía "ambiguo"  → hoy resuelve ÚNICO
//   api run '1. Retrieve' --var kbId=x     decía "cuesta"   → ese nombre ya no existe
//
// El segundo dejó sin cobertura el guarda que impide gastar créditos sin
// confirmar, que es el más caro de perder. Y va a volver a pasar: los nombres
// ahora los escribe el generador de la plataforma y cambian en cada vendorado.
//
// Así que el nombre se DERIVA de la metadata —una que cuesta, una que escribe,
// un prefijo que de verdad es ambiguo— y se afirma el MOTIVO, no sólo el
// código. Si mañana no hubiera ninguna petición que cobre, eso también es un
// hallazgo y se reporta en vez de pasar en verde.
const { entradas } = cargarCatalogo();
const porEfecto = (p) => [...entradas.values()].find(p) ?? null;
const queCuesta = porEfecto((e) => e.spendsCredits && !e.persists);
const queEscribe = porEfecto((e) => e.persists);

// Un prefijo ambiguo de verdad: el nombre corto que comparten dos peticiones de
// carpetas distintas. Derivado, porque cuál es depende de la colección del día.
const porNombreCorto = new Map();
for (const e of entradas.values()) {
  const corto = e.nombre.split(" / ").at(-1);
  porNombreCorto.set(corto, (porNombreCorto.get(corto) ?? 0) + 1);
}
const ambiguo = [...porNombreCorto].find(([, n]) => n > 1)?.[0] ?? null;

const correrCli = (...args) =>
  spawnSync(process.execPath, [fileURLToPath(new URL("./sq-test.mjs", import.meta.url)), ...args], {
    encoding: "utf8",
    env: { ...process.env, SQ_TEST_ENV_FILE: join(TRABAJO, "no-existe.env"), SQ_TEST_API_URL: "https://celda.invalid" },
  });

await comprobar("la colección declara al menos una petición que cuesta y una que escribe", [Boolean(queCuesta), Boolean(queEscribe)], [true, true]);
await comprobar("y al menos un nombre corto ambiguo, para poder probar el desempate", Boolean(ambiguo), true);

if (queCuesta) {
  const r = correrCli("api", "run", queCuesta.nombre, "--var", "kbId=x");
  await comprobar(
    `"${queCuesta.nombre}" sin --yes: sale 2 Y avisa del cargo`,
    [r.status, /créditos/.test(r.stderr), /--yes/.test(r.stderr)],
    [EXIT_USAGE, true, true],
  );
}
if (queEscribe) {
  // Se afirma que el aviso dice QUÉ deja escrito, no cómo lo redacta: el texto
  // sale de la colección y cambia en cada vendorado, pero que llegue al usuario
  // es lo que hace útil la confirmación.
  const r = correrCli("api", "run", queEscribe.nombre, "--var", "kbId=x");
  await comprobar(
    `"${queEscribe.nombre}" sin --yes: sale 2 Y dice qué deja escrito`,
    [r.status, r.stderr.includes(String(queEscribe.persists).trim()), /--yes/.test(r.stderr)],
    [EXIT_USAGE, true, true],
  );
}
if (ambiguo) {
  const r = correrCli("api", "run", ambiguo);
  await comprobar(`"${ambiguo}" es ambiguo: sale 2 Y no elige por vos`, [r.status, /coincide con \d+ peticiones/.test(r.stderr)], [EXIT_USAGE, true]);
}

// Y los nombres que el CI TODAVÍA escribe a mano: que sigan resolviendo a una
// sola petición. Hoy son correctos —los verifiqué uno por uno—, y lo que cierra
// esta aserción es que dejen de serlo en silencio, que es exactamente lo que
// pasó con los dos de arriba: un nombre que ya no existe hace que su caso siga
// saliendo 2, por «no coincide», y el guarda que decía probar queda desarmado.
const NOMBRES_EN_EL_CI = ["Get knowledge base", "Health"];
await comprobar(
  "los nombres que el CI escribe a mano siguen resolviendo a UNA sola petición",
  () =>
    NOMBRES_EN_EL_CI.map((n) => [n, [...entradas.keys()].filter((k) => k.toLowerCase().includes(n.toLowerCase())).length])
      .filter(([, n]) => n !== 1),
  [],
);

console.log(fallos ? `\n${fallos} fallos` : "\nTodo en verde.");
process.exitCode = fallos ? 1 : 0;
