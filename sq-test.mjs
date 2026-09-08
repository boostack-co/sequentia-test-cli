#!/usr/bin/env node
/**
 * sq-test — frente de línea de comandos del Test de Integraciones SEQUENTIA.
 *
 *   node sq-test.mjs                  # sin argumentos abre el menú interactivo
 *   node sq-test.mjs list-kbs
 *   node sq-test.mjs query-kb --kb devops-arquitectura --q "..." --mode fast
 *   node sq-test.mjs call search_articles '{"knowledgeBaseId":"...","query":"..."}'
 *   node sq-test.mjs api health      # el otro carril: REST /api/v1, otro host
 *
 * El catálogo de comandos vive en commands.mjs, compartido con el menú.
 * Ver README.md. Exit codes: 0 ok · 1 la herramienta devolvió isError ·
 * 2 error de uso/config · 3 transporte, auth o rate limit.
 */

import { stdin, stdout } from "node:process";
import { SequentiaMcpClient, McpToolError, McpTransportError } from "./mcp-client.mjs";
import { SequentiaApiClient, ApiTransportError } from "./api-client.mjs";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  API_URL_KEY,
  COMMANDS,
  DEFAULT_URL,
  PLACEHOLDER_KB_ID,
  SIDE_EFFECT_TOOLS,
  TOKEN_KEY,
  USER_ENV_FILE,
  UsageError,
  formatMs,
  invocationPrefix,
  loadDotenv,
  plantillaEnv,
  printPretty,
  printTable,
  resolveApiConfig,
  resolveConfig,
  resolveKbId,
} from "./commands.mjs";

const EXIT_OK = 0;
const EXIT_TOOL_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_TRANSPORT = 3;

// ---------------------------------------------------------------------------
// Parser de argumentos
// ---------------------------------------------------------------------------
const BOOLEAN_FLAGS = new Set(["json", "raw", "verbose", "yes", "help"]);

/**
 * Alias cortos. Son booleanos: nunca pueden ser el valor de otra opción.
 *
 * Va en un `Map` a propósito. Con un objeto común, `"toString" in SHORT_FLAGS`
 * da `true` por herencia del prototipo, así que un valor legítimo como
 * `--q toString` se rechazaba por "falta el valor".
 */
const SHORT_FLAGS = new Map([
  ["-h", "help"],
  ["-v", "verbose"],
]);

/** Opciones válidas en cualquier comando. Las propias de cada uno van en `opts`. */
const GLOBAL_FLAGS = new Set([...BOOLEAN_FLAGS, "url", "token"]);

/**
 * Lo único que tiene sentido al abrir el menú. `--json`, `--raw` y `--yes` son
 * de una ejecución puntual: aceptarlos y no usarlos sería el mismo fallo
 * silencioso que ya cerramos para los flags mal escritos.
 */
const MENU_FLAGS = new Set(["url", "token", "verbose"]);

/**
 * Lo que tiene sentido en el carril API. Deliberadamente NO incluye `--url`,
 * que es el endpoint MCP, ni `--raw`, que es el sobre JSON-RPC: en REST el
 * cuerpo ES el payload y no hay sobre que mostrar. Aceptar cualquiera de los
 * dos sería el mismo fallo silencioso que ya cerramos para los flags mal
 * escritos, solo que peor: `--url` daría la impresión de estar apuntando a otra
 * celda cuando en realidad no se estaría usando.
 */
const API_FLAGS = new Set(["json", "verbose", "help", "api-url", "token"]);

/** Subcomandos del carril API. Crece de a una sesión de la épica por vez. */
const API_SUBCOMMANDS = {
  health: {
    help: "Comprueba que la celda responde. NO usa credencial: si falla, el problema es la URL.",
    opts: [],
  },
};

/**
 * Rechaza opciones que el comando no conoce. Sin esto, un `--mdo precise` se
 * ignoraba en silencio y la consulta salía con el modo por default: el comando
 * terminaba con éxito y el resultado no era el que se pidió. En un banco de
 * pruebas eso invalida el experimento sin avisar.
 */
function assertKnownFlags(flags, allowed, commandName, globales = GLOBAL_FLAGS) {
  const known = new Set([...globales, ...allowed]);
  const unknown = Object.keys(flags).filter((f) => !known.has(f));
  if (unknown.length === 0) return;
  const sugerido = allowed.length
    ? ` Opciones de "${commandName}": ${allowed.map((o) => `--${o}`).join(", ")}.`
    : ` "${commandName}" acepta: ${[...globales].map((o) => `--${o}`).join(", ")}.`;
  throw new UsageError(`Opción desconocida: ${unknown.map((f) => `--${f}`).join(", ")}.${sugerido}`);
}

/**
 * Rechaza posicionales de más: es la contracara de `assertKnownFlags`. Sin
 * esto, `query-kb --kb X --q Y mode precise` consultaba con el modo por
 * default y salía con éxito — el mismo fallo silencioso, por el otro lado.
 */
function assertPositionals(positional, max, commandName, forma) {
  if (positional.length <= max) return;
  const sobran = positional.slice(max);
  throw new UsageError(`Sobran argumentos en "${commandName}": ${sobran.join(" ")}.\n  Forma esperada: ${forma}`);
}

/** ¿Este token es una opción y no el valor de la anterior? */
function looksLikeFlag(token) {
  return token.startsWith("--") || SHORT_FLAGS.has(token);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (SHORT_FLAGS.has(arg)) {
      flags[SHORT_FLAGS.get(arg)] = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);

    // Los booleanos se resuelven ANTES de la forma `=`. Al revés (que era como
    // estaba), `--yes=false` dejaba el string "false" —que es verdadero— y
    // desactivaba la confirmación de las herramientas que cobran crédito.
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq === -1) {
        flags[name] = true;
        continue;
      }
      const v = arg.slice(eq + 1).toLowerCase();
      if (v !== "true" && v !== "false") {
        throw new UsageError(`--${name} es un flag booleano: usá --${name}, --${name}=true o --${name}=false (recibí "${arg.slice(eq + 1)}")`);
      }
      flags[name] = v === "true";
      continue;
    }

    if (eq !== -1) {
      flags[name] = arg.slice(eq + 1);
      continue;
    }

    // Cualquier opción que siga cuenta como valor faltante, incluidos los
    // alias cortos: en `--q -v`, tomar "-v" como la pregunta gastaría una
    // llamada real con un texto que nadie quiso preguntar.
    const next = argv[i + 1];
    if (next === undefined || looksLikeFlag(next)) {
      throw new UsageError(`La opción --${name} necesita un valor (si el valor empieza con "-", usá --${name}=<valor>)`);
    }
    flags[name] = next;
    i++;
  }
  return { flags, positional };
}

function usage() {
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length), "call <tool>".length, "tools".length);
  const rows = Object.entries(COMMANDS).map(([name, cmd]) => `  ${name.padEnd(width)}  ${cmd.help}`);
  const apiRows = Object.entries(API_SUBCOMMANDS).map(([name, sub]) => `  ${`api ${name}`.padEnd(width)}  ${sub.help}`);
  // La ayuda usa el mismo prefijo que los comandos impresos: instalado dice
  // `sq-test`, desde el repo dice `node sq-test.mjs`.
  const cmd = invocationPrefix();
  return `sq-test — Test de Integraciones SEQUENTIA

USO
  ${cmd}${" ".repeat(Math.max(1, 34 - cmd.length))}abre el menú interactivo
  ${cmd} [opciones globales] <comando> [opciones del comando]

COMANDOS (MCP)
${rows.join("\n")}
  ${"init".padEnd(width)}  Crea la configuración del usuario (~/.config/sq-test/.env).
  ${"tools".padEnd(width)}  Lista las herramientas que el servidor declara de verdad.
  ${"call <tool>".padEnd(width)}  Escotilla genérica: ${cmd} call <tool> '<json-args>'

COMANDOS (API REST)
${apiRows.join("\n")}

OPCIONES GLOBALES
  --url <url>     Endpoint MCP (default: ${DEFAULT_URL}).
  --token <tok>   API key de Sequentia; pisa la del .env.
  --json          Imprime el payload des-anidado en JSON (para jq).
  --raw           Imprime el sobre JSON-RPC completo (depurar transporte).
  --verbose, -v   Traza de sesión y rate limit por stderr.
  --yes           Confirma las herramientas con efectos secundarios.
  --help, -h      Esta ayuda.

OPCIONES DEL CARRIL API
  --api-url <url> Origen directo de la celda; pisa el ${API_URL_KEY} del .env.
  Los comandos "api" no aceptan --url (es el endpoint MCP) ni --raw (en REST
  el cuerpo es el payload: no hay sobre que mostrar).

NOTAS
  --kb acepta el UUID o el slug/nombre de la KB (se resuelve solo).
  La API key sale de ~/.config/sq-test/.env (SQ_TEST_TOKEN);
  creá ese archivo con  sq-test init  . También se leen ./.env y \$SQ_TEST_ENV_FILE.
  El carril API usa ${API_URL_KEY}: el origen DIRECTO de tu celda, que suele ser
  un host distinto del endpoint MCP.

EXIT CODES
  0 ok · 1 la herramienta devolvió isError · 2 uso/config · 3 transporte/auth`;
}

/**
 * `sq-test init` — crea la config del usuario. Es lo que vuelve usable una
 * instalación global: con `npm install -g` el paquete queda en node_modules,
 * que no es lugar para dejar un token ni sobrevive a una actualización.
 *
 * Nunca pisa un archivo existente: adentro hay un secreto.
 */
function comandoInit() {
  const { files } = loadDotenv();

  if (existsSync(USER_ENV_FILE)) {
    console.log(`Ya existe: ${USER_ENV_FILE}`);
    console.log("No lo toco (tiene tu token). Editalo a mano si querés cambiarlo.");
  } else {
    mkdirSync(dirname(USER_ENV_FILE), { recursive: true });
    writeFileSync(USER_ENV_FILE, plantillaEnv(), "utf8");
    console.log(`Creado: ${USER_ENV_FILE}`);
    console.log(`Editalo y poné tu API key de Sequentia en ${TOKEN_KEY}.`);
  }

  if (files.length) console.log(`\nArchivos de config que se están leyendo: ${files.join(", ")}`);
  console.log("\nDespués, para probar:  sq-test tools");
  return EXIT_OK;
}

/**
 * `sq-test api <subcomando>` — el carril REST.
 *
 * Va por su propio camino y no toca el cliente MCP: son transportes distintos,
 * contra hosts distintos, y `api health` ni siquiera necesita credencial. Meter
 * esto en el flujo de arriba obligaría a abrir una sesión MCP —gastando uno de
 * los cinco cupos de la credencial— para una petición que no la usa.
 */
async function comandoApi(flags, positional) {
  const cmd = invocationPrefix();
  const disponibles = Object.keys(API_SUBCOMMANDS);
  const sub = positional[1];

  if (!sub) {
    throw new UsageError(`Uso: ${cmd} api <subcomando>. Disponibles: ${disponibles.join(", ")}.`);
  }
  // Object.hasOwn por lo mismo que en el catálogo MCP: `api hasOwnProperty` no
  // debe resolver a la función heredada del prototipo.
  if (!Object.hasOwn(API_SUBCOMMANDS, sub)) {
    throw new UsageError(`Subcomando de api desconocido: "${sub}". Disponibles: ${disponibles.join(", ")}.`);
  }
  const spec = API_SUBCOMMANDS[sub];
  assertKnownFlags(flags, spec.opts, `api ${sub}`, API_FLAGS);
  assertPositionals(positional, 2, `api ${sub}`, `${cmd} api ${sub}`);

  const onDebug = flags.verbose ? (msg) => console.error(`[sq-test] ${msg}`) : null;

  if (sub === "health") {
    // Sin token a propósito: es lo que hace que un fallo acá señale la URL.
    const { apiUrl } = resolveApiConfig(flags, { requireToken: false });
    if (onDebug) onDebug(`celda ${apiUrl}`);
    const client = new SequentiaApiClient({ baseUrl: apiUrl, onDebug });

    const t0 = performance.now();
    const { status, data } = await client.health();
    const ms = performance.now() - t0;

    if (flags.json) {
      // La invariante vale igual acá: bajo --json, stdout lleva JSON válido y
      // nada más. El tiempo es narración y va por stderr.
      console.log(JSON.stringify(data, null, 2));
      console.error(`${status} · ${formatMs(ms)}`);
    } else {
      printPretty(data);
      console.log(`\n${status} · ${formatMs(ms)} · ${apiUrl}`);
    }
    return EXIT_OK;
  }

  // Inalcanzable mientras el catálogo y este switch estén sincronizados; si
  // alguien agrega una entrada y olvida el caso, que se note acá y no con un
  // `undefined` más adelante.
  throw new UsageError(`El subcomando "${sub}" está declarado pero no implementado.`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  parsedFlags = flags;

  if (flags.help) {
    console.log(usage());
    return EXIT_OK;
  }

  if (positional.length === 0) {
    // Sin argumentos y con terminal: el menú. Por pipe o redirección se
    // mantiene ayuda + exit 2, para no colgar un script esperando input que
    // nunca llega.
    if (stdin.isTTY && stdout.isTTY) {
      // Los flags de configuración se le pasan al menú. Descartarlos hacía que
      // `sq-test --url <otro>` abriera un menú apuntando al endpoint default:
      // una opción ignorada en silencio, con acciones que cobran crédito.
      assertKnownFlags(flags, [], "el menú", MENU_FLAGS);
      const { correrMenu } = await import("./menu.mjs");
      return correrMenu({ flags });
    }
    console.log(usage());
    return EXIT_USAGE;
  }

  const commandName = positional[0];

  // `init` va antes de resolveConfig: existe justamente para cuando todavía no
  // hay config, así que no puede exigirla.
  if (commandName === "init") {
    assertKnownFlags(flags, [], "init", new Set());
    assertPositionals(positional, 1, "init", "sq-test init");
    return comandoInit();
  }

  // El carril API va antes de resolver la config MCP: usa otro endpoint, otra
  // resolución, y `api health` no necesita credencial.
  if (commandName === "api") {
    return await comandoApi(flags, positional);
  }

  const isCall = commandName === "call";
  const isTools = commandName === "tools";
  // Object.hasOwn y no un acceso directo: COMMANDS["hasOwnProperty"] devuelve
  // la función heredada del prototipo, que pasa el chequeo de abajo y revienta
  // después con un TypeError crudo en vez de "comando desconocido".
  const command = Object.hasOwn(COMMANDS, commandName) ? COMMANDS[commandName] : undefined;

  if (!command && !isCall && !isTools) {
    throw new UsageError(`Comando desconocido "${commandName}". Corré --help para ver la lista.`);
  }

  const { url, token } = resolveConfig(flags);
  const onDebug = flags.verbose ? (msg) => console.error(`[sq-test] ${msg}`) : null;
  if (onDebug) onDebug(`endpoint ${url}`);

  const client = new SequentiaMcpClient({ url, token, onDebug });

  try {
    // --- tools: lo que el servidor declara realmente ---
    if (isTools) {
      assertKnownFlags(flags, [], "tools");
      assertPositionals(positional, 1, "tools", "node sq-test.mjs tools");
      const { tools, envelope } = await client.listTools();
      if (flags.raw) {
        // --raw es el sobre JSON-RPC; --json, el payload des-anidado. Antes los
        // dos imprimían lo mismo acá y --raw no servía para depurar tools/list.
        console.log(JSON.stringify(envelope, null, 2));
      } else if (flags.json) {
        console.log(JSON.stringify(tools, null, 2));
      } else {
        printTable(tools, [
          { header: "HERRAMIENTA", get: (t) => t.name },
          { header: "REQUERIDOS", get: (t) => (t.inputSchema?.required ?? []).join(", ") || "—" },
          { header: "OPCIONALES", get: (t) => Object.keys(t.inputSchema?.properties ?? {}).filter((p) => !(t.inputSchema?.required ?? []).includes(p)).join(", ") || "—" },
        ]);
        console.log(`\n${tools.length} herramienta(s).`);
      }
      return EXIT_OK;
    }

    // --- call: escotilla genérica ---
    let toolName;
    let args;
    let printer = printPretty;

    if (isCall) {
      // `call` no toma opciones propias: los argumentos van en el JSON posicional.
      assertKnownFlags(flags, [], "call");
      assertPositionals(positional, 3, "call", "node sq-test.mjs call <tool> '<json-args>'");
      toolName = positional[1];
      if (!toolName) throw new UsageError("Uso: node sq-test.mjs call <tool> '<json-args>'");
      const rawArgs = positional[2] ?? "{}";
      try {
        args = JSON.parse(rawArgs);
      } catch (err) {
        throw new UsageError(`Los argumentos deben ser JSON válido: ${err.message}`);
      }
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        throw new UsageError("Los argumentos deben ser un objeto JSON");
      }
    } else {
      toolName = command.tool;
      printer = command.print;
      assertKnownFlags(flags, command.opts ?? [], commandName);
      assertPositionals(positional, 1, commandName, `node sq-test.mjs ${commandName} [opciones]`);
    }

    // La guarda va acá, por NOMBRE DE HERRAMIENTA, para que `call verify_claim`
    // no sea un bypass de la confirmación que exige el subcomando `verify-claim`.
    // Antes de cualquier red: el efecto no debe poder dispararse por accidente.
    // Mismo cuidado con el prototipo: `call toString` no debe parecer una
    // herramienta con efectos secundarios.
    if (Object.hasOwn(SIDE_EFFECT_TOOLS, toolName) && !flags.yes) {
      throw new UsageError(
        `"${toolName}" ${SIDE_EFFECT_TOOLS[toolName]}.\n` +
          `  Volvé a correrlo con --yes si querés hacerlo de verdad.`,
      );
    }

    if (!isCall) {
      if (!flags.kb && command.needsKb) {
        throw new UsageError(`Falta --kb (UUID o slug de la knowledge base)`);
      }

      // `build` es puro, así que lo corremos primero con un KB de mentira solo
      // para validar el resto de los flags. Así un --limit fuera de rango falla
      // sin gastar el round-trip que cuesta resolver el slug de la KB.
      command.build(flags, PLACEHOLDER_KB_ID);

      // Recién ahora resolvemos slug -> UUID (una llamada a list_knowledge_bases).
      const kbId = flags.kb ? await resolveKbId(client, String(flags.kb)) : undefined;
      args = command.build(flags, kbId);
    }

    if (onDebug) onDebug(`${toolName} ${JSON.stringify(args)}`);
    const { data, envelope } = await client.call(toolName, args);

    if (flags.raw) {
      console.log(JSON.stringify(envelope, null, 2));
    } else if (flags.json) {
      // Siempre serializado, también cuando el payload es texto plano: un
      // string crudo no es JSON válido y rompía el `| jq` que --json promete.
      console.log(JSON.stringify(data, null, 2));
    } else {
      printer(data);
    }
    return EXIT_OK;
  } finally {
    await client.close();
  }
}

// El catch vive fuera de main() y necesita saber si se pidió --raw. Lo publica
// main() apenas parsea: un segundo escaneo de process.argv sería otra fuente de
// verdad y ya divergía (no reconocía la forma `--raw=true`).
let parsedFlags = {};

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`Error: ${err.message}`);
    process.exitCode = EXIT_USAGE;
  } else if (err instanceof McpToolError) {
    // Con --raw el sobre JSON-RPC va a stdout igual que en el camino feliz:
    // depurar el transporte hace falta sobre todo cuando algo falla.
    if (parsedFlags.raw && err.envelope) console.log(JSON.stringify(err.envelope, null, 2));
    console.error(`La herramienta ${err.tool} devolvió un error:\n  ${err.message}`);
    process.exitCode = EXIT_TOOL_ERROR;
  } else if (err instanceof McpTransportError || err instanceof ApiTransportError) {
    console.error(`Error de transporte: ${err.message}`);
    if (err.wwwAuthenticate) console.error(`  WWW-Authenticate: ${err.wwwAuthenticate}`);
    if (err.body) console.error(`  Respuesta: ${String(err.body).slice(0, 500)}`);
    process.exitCode = EXIT_TRANSPORT;
  } else {
    console.error(err?.stack ?? String(err));
    process.exitCode = EXIT_TRANSPORT;
  }
}
