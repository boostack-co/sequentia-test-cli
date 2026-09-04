/**
 * Test de Integraciones SEQUENTIA — menú interactivo.
 *
 * Se navega por números (0 configuración, 1 MCP, 2 API) y cada resultado
 * imprime **el comando equivalente y cuánto tardó**. Esa línea sale de los
 * mismos flags que recibe `command.build`, así que lo que se muestra es lo
 * que corrió: se explora clickeando números y se sale sabiendo el comando
 * exacto para scriptearlo.
 *
 * Cero dependencias: `node:readline/promises`.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { SequentiaMcpClient, McpToolError, McpTransportError } from "./mcp-client.mjs";
import {
  COMMANDS,
  DEFAULT_URL,
  TOKEN_KEY,
  USER_ENV_FILE,
  PLACEHOLDER_KB_ID,
  SIDE_EFFECT_TOOLS,
  UsageError,
  buildCommandLine,
  formatMs,
  maskToken,
  printTable,
  resolveConfig,
  resolveKbId,
} from "./commands.mjs";

const TITULO = "Test de Integraciones SEQUENTIA";
const RAYA = "─".repeat(72);

/** Orden de las herramientas MCP en el menú: fija, para que 1.N no se mueva. */
const MCP_ITEMS = [
  "list-kbs",
  "query-kb",
  "search",
  "get-article",
  "list-categories",
  "verify-claim",
  "check-freshness",
  "canonical",
  "record-decision",
  "glossary",
  "context",
  "prefs",
];
/** `tools` no está en COMMANDS (no es una herramienta MCP sino tools/list). */
const TOOLS_ITEM = MCP_ITEMS.length + 1;

class SalirDelMenu extends Error {}

/** Se cancela la acción y se vuelve al menú (sin tumbarlo). */
class CancelarAccion extends Error {}

/**
 * Tope de respuestas inválidas seguidas en un prompt. Sin él, un guion de
 * `menu-smoke.mjs` que se queda corto deja al menú pidiendo lo mismo para
 * siempre: la verificación automatizada se cuelga en vez de fallar, que es
 * peor que fallar.
 */
const MAX_INTENTOS = 3;

// ---------------------------------------------------------------------------
// Estado de la sesión
// ---------------------------------------------------------------------------
class Sesion {
  constructor(cfg, { onDebug = null } = {}) {
    this.url = cfg.url;
    this.token = cfg.token;
    this.onDebug = onDebug;
    this.client = null;
    // Marca si alguna acción falló, para que el runner guionado pueda
    // distinguir una corrida sana de una con errores. El menú interactivo
    // sigue usable igual: esto solo afecta el código de salida.
    this.huboError = false;
  }

  /** Un solo cliente —y por lo tanto una sola sesión MCP— para todo el recorrido. */
  getClient() {
    if (!this.client) {
      this.client = new SequentiaMcpClient({ url: this.url, token: this.token, onDebug: this.onDebug });
    }
    return this.client;
  }

  /** Cambiar la API key o el endpoint obliga a rehacer el handshake. */
  async reset(cambios) {
    Object.assign(this, cambios);
    await this.cerrar();
  }

  async cerrar() {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Ejecución de una acción: comando + salida + tiempo
// ---------------------------------------------------------------------------
/**
 * Corre un comando del catálogo y lo enmarca entre la línea reproducible y el
 * tiempo. Nunca lanza: un error de herramienta se muestra y el menú sigue.
 */
async function ejecutar(sesion, commandName, flags, { extra = {} } = {}) {
  const command = COMMANDS[commandName];
  const needsYes = Object.hasOwn(SIDE_EFFECT_TOOLS, command.tool);
  const linea = buildCommandLine(commandName, flags, { needsYes, url: sesion.url });

  console.log(`\n  $ ${linea}`);
  console.log(`  ${RAYA}`);

  const client = sesion.getClient();
  const t0 = performance.now();
  let msResolverKb = 0;

  try {
    // La KB se resuelve aparte y se cronometra aparte: es una llamada extra y
    // atribuirle ese tiempo al RAG daría una lectura falsa.
    let kbId;
    if (flags.kb) {
      const tKb = performance.now();
      kbId = await resolveKbId(client, String(flags.kb));
      msResolverKb = performance.now() - tKb;
    }
    const args = { ...command.build(flags, kbId), ...extra };
    const { data } = await client.call(command.tool, args);
    const ms = performance.now() - t0;

    command.print(data);
    console.log(`  ${RAYA}`);
    console.log(`  ${pie(ms, msResolverKb, data, client)}`);
  } catch (err) {
    const ms = performance.now() - t0;
    sesion.huboError = true;
    // El mensaje va DENTRO del marco, igual que la salida buena.
    if (err instanceof McpToolError || err instanceof UsageError) {
      console.log(`  ✗ ${err.message}`);
    } else if (err instanceof McpTransportError) {
      console.log(`  ✗ transporte: ${err.message}`);
    } else {
      console.log(`  ✗ ${err?.message ?? err}`);
    }
    console.log(`  ${RAYA}`);
    // El tiempo se imprime igual: cuánto tardó en fallar es un dato, sobre
    // todo en timeouts y rate limits.
    console.log(`  ${pie(ms, msResolverKb, null, client)}`);
  }
}

/** Línea de cierre: wall-clock, latencia del servidor y presupuesto restante. */
function pie(ms, msResolverKb, data, client) {
  const partes = [formatMs(ms)];
  if (msResolverKb > 0) partes.push(`resolver KB ${formatMs(msResolverKb)}`);
  // `latencyMs` es del servidor; el wall-clock incluye red y handshake. La
  // diferencia entre ambos es justo lo que un banco de integraciones mide.
  if (data?.latencyMs !== undefined) partes.push(`servidor: ${formatMs(data.latencyMs)}`);
  if (data?.cached !== undefined) partes.push(`cache: ${data.cached ? "sí" : "no"}`);
  const rl = client?.rateLimit;
  if (rl?.remaining !== undefined) partes.push(`${rl.remaining}/${rl.limit} restantes`);
  return partes.join(" · ");
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
async function pedirFlags(rl, sesion, command) {
  const flags = {};
  for (const p of command.prompts ?? []) {
    const valor = p.kind === "kb" ? await pedirKb(rl, sesion, p) : await pedirTexto(rl, p);
    if (valor !== undefined && valor !== "") flags[p.opt] = valor;
  }
  return flags;
}

function etiqueta(p) {
  const bits = [];
  if (p.choices) bits.push(p.choices.join(" | "));
  if (p.range) bits.push(`${p.range[0]}-${p.range[1]}`);
  if (p.default !== undefined) bits.push(`default: ${p.default}`);
  if (p.hint) bits.push(p.hint);
  const sufijo = bits.length ? `  (${bits.join(", ")})` : p.required ? "" : "  (Enter para omitir)";
  return `  ${p.label}${sufijo}: `;
}

async function pedirTexto(rl, p) {
  for (let intento = 0; ; intento++) {
    if (intento >= MAX_INTENTOS) throw new CancelarAccion(`demasiadas respuestas inválidas para "${p.label}"`);
    const raw = (await rl.question(etiqueta(p))).trim();
    if (raw === "") {
      if (p.required) {
        console.log(`  ✗ ${p.label} es obligatorio.`);
        continue;
      }
      return undefined; // omitido: el servidor aplica su default
    }
    if (p.choices && !p.choices.includes(raw)) {
      console.log(`  ✗ tiene que ser uno de: ${p.choices.join(", ")}`);
      continue;
    }
    if (p.range) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < p.range[0] || n > p.range[1]) {
        console.log(`  ✗ tiene que ser un entero entre ${p.range[0]} y ${p.range[1]}`);
        continue;
      }
    }
    if (p.maxLen && raw.length > p.maxLen) {
      console.log(`  ✗ son ${raw.length} caracteres; el servidor acepta hasta ${p.maxLen}`);
      continue;
    }
    if (p.kind === "json") {
      try {
        JSON.parse(raw);
      } catch (err) {
        console.log(`  ✗ tiene que ser JSON válido: ${err.message}`);
        continue;
      }
    }
    return raw;
  }
}

/** Elegir la KB de una lista numerada en vez de tipear un UUID. */
async function pedirKb(rl, sesion, p) {
  const kbs = await listarKbs(sesion);
  if (kbs.length === 0) {
    console.log("  (no hay knowledge bases accesibles con este token)");
    return undefined;
  }
  console.log(`\n  ${p.label}:`);
  kbs.forEach((kb, i) => {
    console.log(`   ${String(i + 1).padStart(2)}. ${kb.slug}${kb.articleCount ? `  (${kb.articleCount} artículos)` : "  (vacía)"}`);
  });
  for (let intento = 0; ; intento++) {
    if (intento >= MAX_INTENTOS) throw new CancelarAccion("demasiadas respuestas inválidas al elegir la knowledge base");
    const raw = (await rl.question(p.required ? "  Número: " : "  Número (Enter para omitir): ")).trim();
    if (raw === "") {
      if (!p.required) return undefined;
      console.log("  ✗ elegí una.");
      continue;
    }
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= kbs.length) {
      // Se devuelve el SLUG, no el UUID: el comando impreso queda legible y el
      // CLI lo resuelve igual.
      return kbs[n - 1].slug;
    }
    console.log(`  ✗ elegí un número entre 1 y ${kbs.length}.`);
  }
}

/**
 * SIEMPRE pide la lista al servidor, sin cachearla.
 *
 * Cachearla por sesión rompía el caso más normal de un banco de pruebas: crear
 * una KB en la app con el menú abierto y no verla aparecer en el selector,
 * aunque `1.1 Listar knowledge bases` —que sí consulta— ya la mostrara. Una
 * llamada de más vale mucho menos que un selector que miente.
 */
async function listarKbs(sesion) {
  const { data } = await sesion.getClient().call("list_knowledge_bases", {});
  return Array.isArray(data) ? data : [];
}

// ---------------------------------------------------------------------------
// Pantallas
// ---------------------------------------------------------------------------
function encabezado(sesion) {
  const host = sesion.url.replace(/^https?:\/\//, "").replace(/\/mcp$/, "");
  console.log(`\n  ${TITULO}`);
  console.log(`  ${host}\n`);
}

async function pantallaRaiz(rl, sesion) {
  encabezado(sesion);
  console.log("   0. Configuración");
  console.log(`   1. MCP                     ${MCP_ITEMS.length + 1} funcionalidades`);
  console.log("   2. API                     (próximamente)\n");
  console.log("   q. Salir");
  const op = (await rl.question("\n   > ")).trim().toLowerCase();

  if (op === "q" || op === "") throw new SalirDelMenu();
  if (op === "0") return pantallaConfig(rl, sesion);
  if (op === "2") return pantallaApi(rl);
  if (op === "1") return pantallaMcp(rl, sesion);
  // Atajo: `1.4` entra directo a la funcionalidad desde la raíz.
  const directo = /^1\.(\d+)$/.exec(op);
  if (directo) return correrItemMcp(rl, sesion, Number(directo[1]));
  console.log("   ✗ opción inválida.");
}

async function pantallaMcp(rl, sesion) {
  for (;;) {
    encabezado(sesion);
    console.log("   1. MCP\n");
    const mitad = Math.ceil(MCP_ITEMS.length / 2);
    for (let i = 0; i < mitad; i++) {
      console.log(`   ${filaMcp(i)}${filaMcp(i + mitad)}`);
    }
    console.log(`   ${etiquetaItem(TOOLS_ITEM, "Herramientas declaradas")}`);
    console.log("\n   ⚠ consumen crédito y escriben en el registro de auditoría\n");
    console.log("   b. Volver     q. Salir");

    const op = (await rl.question("\n   > ")).trim().toLowerCase();
    if (op === "q") throw new SalirDelMenu();
    if (op === "b" || op === "") return;
    const n = Number(/^1\.(\d+)$/.exec(op)?.[1] ?? op);
    if (!Number.isInteger(n) || n < 1 || n > TOOLS_ITEM) {
      console.log("   ✗ opción inválida.");
      continue;
    }
    await correrItemMcp(rl, sesion, n);
    await rl.question("\n   [Enter para volver] ");
  }
}

function filaMcp(i) {
  if (i >= MCP_ITEMS.length) return "";
  const name = MCP_ITEMS[i];
  const cmd = COMMANDS[name];
  const marca = Object.hasOwn(SIDE_EFFECT_TOOLS, cmd.tool) ? " ⚠" : "";
  return etiquetaItem(i + 1, cmd.label + marca).padEnd(42);
}

const etiquetaItem = (n, texto) => `${`1.${n}`.padEnd(5)} ${texto}`;

async function correrItemMcp(rl, sesion, n) {
  if (n === TOOLS_ITEM) return listarHerramientas(sesion);

  const commandName = MCP_ITEMS[n - 1];
  if (!commandName) {
    console.log("   ✗ opción inválida.");
    return;
  }
  const command = COMMANDS[commandName];
  console.log(`\n  1.${n}  ${command.label}   —   ${commandName}`);

  // Pedir los datos también toca la red: el selector de KB llama a
  // list_knowledge_bases. Si eso explota (token inválido, por ejemplo) el
  // error tiene que morir ACÁ. Antes se propagaba hasta correrMenu y cerraba
  // el menú entero con estado 3, justo cuando el usuario necesitaba entrar a
  // Configuración a corregir el token.
  let flags;
  try {
    flags = await pedirFlags(rl, sesion, command);
  } catch (err) {
    if (err instanceof CancelarAccion) {
      // No es un fallo de la integración: no ensucia el código de salida.
      console.log(`
  Cancelado: ${err.message}.`);
      return;
    }
    sesion.huboError = true;
    if (err instanceof McpToolError || err instanceof UsageError) {
      console.log(`\n  ✗ ${err.message}`);
    } else if (err instanceof McpTransportError) {
      console.log(`\n  ✗ transporte: ${err.message}`);
    } else {
      throw err; // un bug de programación sí debe salir a la superficie
    }
    console.log("  (revisá la API key o el endpoint en 0. Configuración)");
    return;
  }

  // La confirmación va acá, con el efecto explicado, y el comando impreso
  // lleva --yes. Es la misma guarda que aplica el CLI, por nombre de herramienta.
  if (Object.hasOwn(SIDE_EFFECT_TOOLS, command.tool)) {
    console.log(`\n  ⚠ ${command.tool} ${SIDE_EFFECT_TOOLS[command.tool]}.`);
    const ok = (await rl.question("  Escribí 'si' para ejecutarlo: ")).trim().toLowerCase();
    if (ok !== "si") {
      console.log("  Cancelado. No se llamó a nada.");
      return;
    }
    flags.yes = true;
  }

  await ejecutar(sesion, commandName, flags);
}

/** `tools` no pasa por COMMANDS: es tools/list, no una herramienta. */
async function listarHerramientas(sesion) {
  const linea = buildCommandLine("tools", {}, { url: sesion.url });
  console.log(`\n  $ ${linea}`);
  console.log(`  ${RAYA}`);
  const client = sesion.getClient();
  const t0 = performance.now();
  try {
    const { tools } = await client.listTools();
    const ms = performance.now() - t0;
    printTable(tools, [
      { header: "HERRAMIENTA", get: (t) => t.name },
      { header: "REQUERIDOS", get: (t) => (t.inputSchema?.required ?? []).join(", ") || "—" },
    ]);
    console.log(`\n${tools.length} herramienta(s).`);
    console.log(`  ${RAYA}`);
    console.log(`  ${pie(ms, 0, null, client)}`);
  } catch (err) {
    sesion.huboError = true;
    console.log(`  ✗ ${err?.message ?? err}`);
    console.log(`  ${RAYA}`);
    console.log(`  ${pie(performance.now() - t0, 0, null, client)}`);
  }
}

async function pantallaConfig(rl, sesion) {
  for (;;) {
    encabezado(sesion);
    console.log("   0. Configuración\n");
    console.log(`   0.1  API key      ${maskToken(sesion.token).padEnd(30)} (${TOKEN_KEY} del .env)`);
    console.log(`   0.2  Endpoint     ${sesion.url}`);
    console.log("   0.3  Probar conexión\n");
    console.log("   Los cambios valen para esta sesión; el .env no se toca.");
    console.log(`   Config del usuario: ${USER_ENV_FILE}\n`);
    console.log("   b. Volver     q. Salir");

    const op = (await rl.question("\n   > ")).trim().toLowerCase();
    if (op === "q") throw new SalirDelMenu();
    if (op === "b" || op === "") return;

    if (op === "0.1" || op === "1") {
      const t = (await rl.question("  API key (Enter para dejarla como está): ")).trim();
      if (t) {
        await sesion.reset({ token: t });
        console.log(`  API key cambiada para esta sesión: ${maskToken(t)}`);
      }
    } else if (op === "0.2" || op === "2") {
      const u = (await rl.question(`  Endpoint (Enter para dejarlo; default ${DEFAULT_URL}): `)).trim();
      if (u) {
        await sesion.reset({ url: u });
        console.log(`  Endpoint cambiado para esta sesión: ${u}`);
      }
    } else if (op === "0.3" || op === "3") {
      await probarConexion(sesion);
    } else {
      console.log("   ✗ opción inválida.");
      continue;
    }
    await rl.question("\n   [Enter para seguir] ");
  }
}

async function probarConexion(sesion) {
  console.log(`\n  $ ${buildCommandLine("tools", {}, { url: sesion.url })}`);
  console.log(`  ${RAYA}`);
  const client = sesion.getClient();
  const t0 = performance.now();
  try {
    const { tools } = await client.listTools();
    const ms = performance.now() - t0;
    console.log(`  ✓ ${client.serverInfo?.name ?? "?"} ${client.serverInfo?.version ?? ""} · ${tools.length} herramientas`);
    console.log(`  ${RAYA}`);
    console.log(`  ${pie(ms, 0, null, client)}`);
  } catch (err) {
    // Sin esto, `menu-smoke.mjs 0 0.4` reportaba como sana una integración
    // caída: el chequeo de conexión fallaba y la corrida igual salía con 0.
    sesion.huboError = true;
    console.log(`  ✗ ${err?.message ?? err}`);
    console.log(`  ${RAYA}`);
    console.log(`  ${pie(performance.now() - t0, 0, null, client)}`);
  }
}

async function pantallaApi(rl) {
  console.log("\n  2. API — próximamente\n");
  console.log("  Va a cubrir la API REST del workspace con la misma credencial `sk_live_…`");
  console.log("  y los mismos scopes que usa MCP (rag.query, kb.read, agent.*).\n");
  console.log("  Hoy no hay nada cableado: esta pantalla marca el lugar donde entra");
  console.log("  la segunda integración del banco.");
  await rl.question("\n   [Enter para volver] ");
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------
/** La terminal real. Se aísla detrás de `io` para poder guionar el menú. */
function ioDeTerminal() {
  const rl = createInterface({ input: stdin, output: stdout });
  return {
    question: (prompt) => rl.question(prompt),
    close: () => rl.close(),
    onSigint: (fn) => rl.on("SIGINT", fn),
  };
}

/**
 * @param {object} [opts]
 * @param {{question:(p:string)=>Promise<string>, close:()=>void, onSigint?:Function}} [opts.io]
 *   Entrada/salida. Se inyecta en las pruebas: el menú solo corre con TTY, y
 *   `readline` sobre un pipe lee una línea y se cuelga, así que sin esta
 *   costura no habría forma de ejercerlo de punta a punta.
 * @param {object} [opts.flags] Flags globales del CLI (`--url`, `--token`,
 *   `--verbose`). Descartarlos hacía que `sq-mcp --url <otro>` abriera un menú
 *   apuntando al endpoint por default.
 */
export async function correrMenu({ io = ioDeTerminal(), flags = {} } = {}) {
  const cfg = resolveConfig(flags);
  // --verbose se aceptaba al abrir el menú y no se usaba: la traza de sesión,
  // rate limit y sesiones sin cerrar nunca aparecía.
  const onDebug = flags.verbose ? (msg) => console.error(`[sq-mcp] ${msg}`) : null;
  const sesion = new Sesion(cfg, { onDebug });
  if (onDebug) onDebug(`endpoint ${cfg.url}`);
  const rl = io;

  // Ctrl+C tiene que cerrar la sesión MCP: si no, queda ocupando uno de los
  // 5 cupos por credencial durante 30 minutos.
  const alSalir = async () => {
    await sesion.cerrar();
    rl.close();
  };
  rl.onSigint?.(() => {
    console.log("\n");
    alSalir().then(() => process.exit(0));
  });

  try {
    for (;;) await pantallaRaiz(rl, sesion);
  } catch (err) {
    if (!(err instanceof SalirDelMenu)) {
      console.error(`\n  ✗ ${err?.message ?? err}`);
      await alSalir();
      return 3;
    }
  }
  await alSalir();
  console.log("\n  Hasta luego.\n");
  // Si alguna acción falló, el código lo refleja. El menú siguió usable
  // igual —cada error se mostró y se volvió al menú—, pero una corrida
  // guionada de `menu-smoke.mjs` tiene que poder distinguir una integración
  // sana de una rota: sin esto, un 401 en `list-kbs` salía con 0.
  return sesion.huboError ? 1 : 0;
}
