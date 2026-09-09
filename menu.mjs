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
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SequentiaMcpClient, McpToolError, McpTransportError } from "./mcp-client.mjs";
import { SequentiaApiClient } from "./api-client.mjs";
import { AGENT_COMMANDS, RETRIEVAL_TTL_MS, agentNecesitaConfirmacion, claveIdempotencia, recordarRetrieval } from "./agent.mjs";
import { buscarPeticion, cargarCatalogo, efectosDe, necesitaConfirmacion, resolverPeticion } from "./catalog.mjs";
import { diagnosticar, formatearInforme } from "./doctor.mjs";
import { catalogoDe, comparar, formatearDerivas, guardarCache, traerPublicada } from "./collection-sync.mjs";
import { MAX_SEND_RISK, correrBucle, narrar, resolveLlmConfig } from "./loop.mjs";
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
  COLLECTION_URL_KEY,
  loadDotenv,
  printPretty,
  resolveApiConfig,
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
  // El 13. Va acá y no calculado: ver TOOLS_ITEM abajo.
  "tools",
];
/**
 * `tools` no está en COMMANDS: no es una herramienta MCP sino `tools/list`.
 * Ocupa el número 13 y lo ocupa **por posición en la lista**, no por aritmética.
 *
 * Antes esto era `MCP_ITEMS.length + 1`, y ahí estaba el defecto: la herramienta
 * número 13 habría movido `tools` de `1.13` a `1.14` **sola**, rompiendo el
 * README y los guiones de `menu-smoke.mjs` —que son literalmente secuencias de
 * números— sin que nadie tocara esta línea. Un número publicado que se mueve
 * solo rompe en silencio, que es la peor forma de romper algo.
 *
 * Con la posición como fuente, agregar una herramienta al FINAL de `MCP_ITEMS`
 * le da el 14 y deja `tools` donde estaba. Es lo que hace cierta la regla de
 * append-only: los números del menú son contrato público.
 */
export const TOOLS_KEY = "tools";
const TOOLS_ITEM = MCP_ITEMS.indexOf(TOOLS_KEY) + 1;
if (TOOLS_ITEM === 0) throw new Error(`MCP_ITEMS debe incluir "${TOOLS_KEY}": es el ítem que lista las herramientas.`);

/** Los números publicados del menú MCP, para que el CI pueda afirmarlos. */
export const NUMEROS_MCP = Object.freeze(
  Object.fromEntries(MCP_ITEMS.map((nombre, i) => [nombre, i + 1])),
);

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
  // La lista YA incluye `tools`, así que el `+ 1` de antes contaba uno de más.
  console.log(`   1. MCP                     ${MCP_ITEMS.length} funcionalidades`);
  // Regla 2: las secciones nuevas van al FINAL de la raíz, nunca intercaladas.
  // Su número es su posición, así que agregar una no mueve ninguna.
  SECCIONES_API.forEach((seccion, i) => {
    const n = i + PRIMERA_SECCION_API;
    console.log(`   ${n}. ${seccion.titulo.padEnd(24)} ${seccion.items.length} ${seccion.items.length === 1 ? "acción" : "acciones"}`);
  });
  console.log("\n   q. Salir");
  const op = (await rl.question("\n   > ")).trim().toLowerCase();

  if (op === "q" || op === "") throw new SalirDelMenu();
  if (op === "0") return pantallaConfig(rl, sesion);
  if (op === "1") return pantallaMcp(rl, sesion);
  // Atajo: `1.4` entra directo a la funcionalidad desde la raíz.
  const directo = /^1\.(\d+)$/.exec(op);
  if (directo) return correrItemMcp(rl, sesion, Number(directo[1]));

  // Regla 4: el salto desde la raíz vale para TODA sección, no solo la 1.
  const nSeccion = Number(op);
  const esApi = (n) => Number.isInteger(n) && n >= PRIMERA_SECCION_API && n < PRIMERA_SECCION_API + SECCIONES_API.length;
  if (esApi(nSeccion)) return pantallaSeccionApi(rl, sesion, nSeccion);

  const saltoApi = /^(\d+)\.(\d+)$/.exec(op);
  if (saltoApi && esApi(Number(saltoApi[1]))) {
    const item = INDICE_API.get(op);
    if (item) {
      await correrItemApi(rl, sesion, item);
      return rl.question("\n   [Enter para volver] ");
    }
  }
  // Regla 3: el nombre del comando vale como alias, también desde la raíz.
  const porAlias = INDICE_API.get(op);
  if (porAlias) {
    await correrItemApi(rl, sesion, porAlias);
    return rl.question("\n   [Enter para volver] ");
  }
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
    console.log("\n   ⚠ consumen crédito y escriben en el registro de auditoría\n");
    console.log("   b. Volver     q. Salir");

    const op = (await rl.question("\n   > ")).trim().toLowerCase();
    if (op === "q") throw new SalirDelMenu();
    if (op === "b" || op === "") return;
    const n = Number(/^1\.(\d+)$/.exec(op)?.[1] ?? op);
    if (!Number.isInteger(n) || n < 1 || n > MCP_ITEMS.length) {
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
  // `tools` es parte de la numeración pero no de COMMANDS: es `tools/list`.
  if (name === TOOLS_KEY) return etiquetaItem(i + 1, "Herramientas declaradas").padEnd(42);
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
 *   `--verbose`). Descartarlos hacía que `sq-test --url <otro>` abriera un menú
 *   apuntando al endpoint por default.
 */
export async function correrMenu({ io = ioDeTerminal(), flags = {} } = {}) {
  const cfg = resolveConfig(flags);
  // --verbose se aceptaba al abrir el menú y no se usaba: la traza de sesión,
  // rate limit y sesiones sin cerrar nunca aparecía.
  const onDebug = flags.verbose ? (msg) => console.error(`[sq-test] ${msg}`) : null;
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

// ---------------------------------------------------------------------------
// El carril API en el menú
// ---------------------------------------------------------------------------
/**
 * Las secciones de la raíz, y por lo tanto los números publicados.
 *
 * **El número es la posición**, igual que en `MCP_ITEMS`: no se calcula ni se
 * escribe a mano. Eso hace cierta la regla que gobierna todo esto —los números
 * del menú son contrato público, están en el README y en los guiones de
 * `menu-smoke.mjs`, y renumerarlos rompe EN SILENCIO—:
 *
 *  1. **Append-only.** Un número publicado no se reasigna ni se reordena jamás.
 *     Un ítem nuevo va al final de su sección, aunque la documentación lo liste
 *     en otro orden.
 *  2. **Una sección nueva va al final de la raíz**, no intercalada.
 *  3. **El nombre del comando vale como alias del número.** Tipear `3.1` o
 *     `retrieve` hace lo mismo: es la escotilla que deja crecer la lista sin
 *     volverla un muro, porque quien sabe qué quiere no cuenta renglones.
 *  4. **El salto desde la raíz vale para toda sección**: `3.4` funciona igual
 *     que `1.4`.
 *
 * `0. Configuración` y `1. MCP` tienen pantalla propia y su propio ruteo; de
 * `2` en adelante son estas, que comparten uno solo.
 */
const SECCIONES_API = [
  {
    titulo: "API · lectura",
    nota: "no gastan créditos ni escriben",
    items: [
      { etiqueta: "Estado de la celda", alias: "health", necesita: "url", correr: (ctx) => itemHealth(ctx) },
      { etiqueta: "Qué declara la colección", alias: "list", necesita: "nada", correr: (ctx) => itemList(ctx) },
      { etiqueta: "Correr una petición de la colección", alias: "run", correr: (ctx) => itemRun(ctx) },
    ],
  },
  {
    titulo: "API · carril agéntico",
    nota: "⚠ gastan créditos de IA o escriben",
    items: [
      { etiqueta: "Recuperar fragmentos ⚠", alias: "retrieve", agente: "retrieve" },
      { etiqueta: "Consultar el carril gestionado ⚠", alias: "query", agente: "query" },
      { etiqueta: "Verificar una afirmación ⚠", alias: "verify", agente: "verify" },
      { etiqueta: "Estado del índice", alias: "index-status", agente: "index-status" },
      { etiqueta: "Reportar un hueco ⚠", alias: "gap-report", agente: "gap-report" },
      { etiqueta: "Calificar una recuperación ⚠", alias: "feedback", agente: "feedback" },
    ],
  },
  {
    titulo: "Agente",
    nota: "el bucle gobernado — necesita TU modelo",
    items: [
      { etiqueta: "Correr el bucle ⚠", alias: "loop", correr: (ctx) => itemLoop(ctx, { generar: true }) },
      { etiqueta: "Solo recuperar, sin modelo ⚠", alias: "loop-no-generate", correr: (ctx) => itemLoop(ctx, { generar: false }) },
    ],
  },
  {
    titulo: "Diagnóstico",
    nota: "qué puede tu credencial",
    items: [{ etiqueta: "Perfilar la credencial", alias: "doctor", correr: (ctx) => itemDoctor(ctx) }],
  },
  {
    titulo: "Colección",
    nota: "el original vive en el repo; Postman es la copia",
    items: [
      { etiqueta: "Contrastar con lo publicado", alias: "collection-check", correr: (ctx) => itemCollection(ctx, false) },
      { etiqueta: "Contrastar y actualizar la caché", alias: "collection-refresh", correr: (ctx) => itemCollection(ctx, true) },
    ],
  },
];

/** El número de raíz de cada sección de API. La primera es la 2. */
const PRIMERA_SECCION_API = 2;

/** `{ "3.1": {...}, "retrieve": {...} }` — el número y el alias llevan al mismo ítem. */
const INDICE_API = (() => {
  const out = new Map();
  SECCIONES_API.forEach((seccion, s) => {
    const nSeccion = s + PRIMERA_SECCION_API;
    seccion.items.forEach((item, i) => {
      const entrada = { ...item, seccion: nSeccion, n: i + 1 };
      out.set(`${nSeccion}.${i + 1}`, entrada);
      // Regla 3: el nombre del comando vale como alias del número.
      out.set(item.alias, entrada);
    });
  });
  return out;
})();

/** Los números publicados del carril API, para que el CI pueda afirmarlos. */
export const NUMEROS_API = Object.freeze(
  Object.fromEntries([...INDICE_API].filter(([k]) => k.includes(".")).map(([k, v]) => [k, v.alias])),
);

/**
 * El contexto que reciben los ítems: cliente REST ya construido, la config y
 * el `rl` para preguntar.
 *
 * Se arma **perezosamente**, y eso es a propósito: `SQ_TEST_API_URL` no es
 * necesaria para el carril MCP, así que exigirla al abrir el menú dejaría sin
 * menú a quien solo usa MCP. Falta la URL → falla la sección de API, no el
 * programa.
 */
async function contextoApi(rl, sesion, necesita = "credencial") {
  // `list` lee la colección empaquetada: no toca la red ni necesita nada
  // configurado, igual que `api list` en el CLI. Pedirle la URL de la celda
  // sería exigir configuración para algo que funciona sin ella.
  if (necesita === "nada") return { rl, sesion, cfg: {}, client: null };

  // `health` va SIN credencial a propósito: es el primer diagnóstico, y que
  // falle ahí señala la URL y no la key.
  const requireToken = necesita !== "url";
  if (!sesion.api || sesion.api.conToken !== requireToken) {
    const { apiUrl, token } = resolveApiConfig({}, { requireToken });
    sesion.api = {
      conToken: requireToken,
      cfg: { apiUrl, token },
      client: new SequentiaApiClient({ baseUrl: apiUrl, token, onDebug: sesion.onDebug }),
    };
  }
  return { rl, sesion, ...sesion.api };
}

/** Corre algo del carril API mostrando el comando equivalente y los tiempos. */
async function correrApi(ctx, { comando, flags = {}, necesitaYes = false }, fn) {
  // Invariante 1: el comando impreso reproduce la acción. Se arma con el mismo
  // constructor que usa el CLI, así que no puede divergir.
  console.log(`\n  $ ${buildCommandLine(`api ${comando}`, flags, { needsYes: necesitaYes })}\n`);
  const t0 = performance.now();
  try {
    await fn();
  } catch (err) {
    ctx.sesion.huboError = true;
    console.error(`  ✗ ${err?.message ?? err}`);
  }
  // Invariante 4: el wall-clock va separado de la latencia del servidor.
  console.log(`\n  ${formatMs(performance.now() - t0)} de reloj`);
}

/**
 * El selector de KB del carril API.
 *
 * Lista por REST y no por MCP: son las mismas knowledge bases, pero pedirlas
 * por MCP obligaría a tener sesión MCP abierta para una acción que no la usa —
 * y una de las cosas que el carril enseña es que son dos credenciales y dos
 * endpoints distintos.
 */
async function pedirKbApi(ctx) {
  let kbs = [];
  try {
    const { data } = await ctx.client.request("GET", "/knowledge-bases");
    kbs = data?.knowledgeBases ?? data?.data ?? (Array.isArray(data) ? data : []);
  } catch (err) {
    console.error(`  (no pude listar las KBs: ${err?.message ?? err})`);
  }
  if (!kbs.length) return (await ctx.rl.question("   knowledge base (slug o id): ")).trim();

  console.log("");
  kbs.forEach((kb, i) => console.log(`   ${String(i + 1).padStart(2)}. ${kb.name ?? kb.slug ?? kb.id}`));
  const op = (await ctx.rl.question("\n   > ")).trim();
  const n = Number(op);
  if (Number.isInteger(n) && n >= 1 && n <= kbs.length) return kbs[n - 1].slug ?? kbs[n - 1].id;
  // Lo tipeado vale como slug: no obligar a elegir de la lista es lo que deja
  // usar una KB que la key ve pero el listado paginó fuera.
  return op;
}

async function itemHealth(ctx) {
  await correrApi(ctx, { comando: "health" }, async () => {
    const { status, data } = await ctx.client.health();
    printPretty(data);
    console.log(`\n  ${status} · ${ctx.cfg.apiUrl}`);
  });
}

async function itemList(ctx) {
  await correrApi(ctx, { comando: "list" }, async () => {
    const { entradas } = cargarCatalogo();
    printTable([...entradas.values()], [
      { header: "PETICIÓN", get: (e) => e.nombre },
      { header: "MÉTODO", get: (e) => e.metodo },
      { header: "SCOPES", get: (e) => e.scopes.join(" | ") || "—" },
      { header: "EFECTOS", get: (e) => efectosDe(e) },
    ]);
    console.log(`\n  ${entradas.size} peticiones.`);
  });
}

async function itemRun(ctx) {
  const { entradas, coleccion } = cargarCatalogo();
  const nombre = (await ctx.rl.question("\n   nombre de la petición (o parte): ")).trim();
  if (!nombre) throw new CancelarAccion();
  const entrada = buscarPeticion(entradas, nombre);

  const vars = {};
  for (const v of entrada.variables) {
    vars[v] = v === "kbId" ? await pedirKbApi(ctx) : (await ctx.rl.question(`   ${v}: `)).trim();
  }
  const confirmar = necesitaConfirmacion(entrada);
  if (confirmar && !(await confirmarEfecto(ctx.rl, `"${entrada.nombre}" ${efectosDe(entrada)}`))) return;

  const flags = Object.fromEntries(Object.entries(vars).map(([k, v]) => [`var ${k}`, v]));
  await correrApi(ctx, { comando: `run '${entrada.nombre}'`, flags, necesitaYes: confirmar }, async () => {
    const p = resolverPeticion(entrada, vars, coleccion);
    const { status, data } = await ctx.client.request(p.metodo, p.ruta, { body: p.body, headers: p.cabeceras, auth: p.auth });
    printPretty(data);
    console.log(`\n  ${status} · ${p.metodo} ${p.ruta}`);
  });
}

/** Los seis atajos del carril agéntico, manejados por su declaración. */
async function itemAgente(ctx, nombre) {
  const spec = AGENT_COMMANDS[nombre];
  const flags = {};
  for (const opt of spec.opts) {
    if (opt === "kb") flags.kb = await pedirKbApi(ctx);
    else {
      const v = (await ctx.rl.question(`   --${opt}${opt === "kbs" ? " (separadas por coma)" : ""}: `)).trim();
      if (v) flags[opt] = v;
    }
  }
  const confirmar = agentNecesitaConfirmacion(spec);
  if (confirmar) {
    const que = [spec.persists && `persiste ${spec.persists}`, spec.spendsCredits && "gasta créditos de IA"].filter(Boolean).join(" y ");
    if (!(await confirmarEfecto(ctx.rl, `"api ${nombre}" ${que}`))) return;
  }

  await correrApi(ctx, { comando: nombre, flags, necesitaYes: confirmar }, async () => {
    const body = spec.build(flags, { celda: ctx.cfg.apiUrl });
    const ruta = typeof spec.ruta === "function" ? spec.ruta(flags) : spec.ruta;
    const cabeceras = {};
    if (spec.idempotencia && body !== undefined) cabeceras["x-idempotency-key"] = claveIdempotencia(spec.idempotencia, body);
    const { status, data } = await ctx.client.request(spec.metodo, ruta, { body, headers: cabeceras });
    printPretty(data);
    console.log(`\n  ${status} · ${spec.metodo} ${ruta}`);
    if (spec.captura === "retrievalId" && data?.retrievalId) {
      recordarRetrieval({ id: data.retrievalId, kb: String(flags.kb), celda: ctx.cfg.apiUrl });
      console.log(`  retrievalId recordado por ${RETRIEVAL_TTL_MS / 60000} min`);
    }
  });
}

async function itemLoop(ctx, { generar }) {
  const kb = await pedirKbApi(ctx);
  const pregunta = (await ctx.rl.question("   pregunta: ")).trim();
  if (!pregunta) throw new CancelarAccion();
  const flags = { kb, ...(generar ? {} : { "no-generate": true }) };
  if (!(await confirmarEfecto(ctx.rl, "el bucle recupera, y eso gasta créditos de IA"))) return;

  await correrApi(ctx, { comando: `loop '${pregunta}'`, flags }, async () => {
    const llm = generar ? resolveLlmConfig({}) : null;
    const traza = [];
    await correrBucle({
      client: ctx.client,
      traza,
      pregunta,
      kb,
      opciones: { umbral: MAX_SEND_RISK, generarRespuesta: generar, gestionado: false, llm, onDebug: ctx.sesion.onDebug },
      onPaso: (paso) => {
        if (paso.paso !== "decidir") console.log(`  ${narrar(paso, { mostrarRespuesta: true })}`);
      },
    });
    const fin = traza.findLast((p) => p.paso === "decidir");
    if (fin) console.log(`\n  ${narrar(fin).trim()}`);
  });
}

async function itemDoctor(ctx) {
  await correrApi(ctx, { comando: "doctor" }, async () => {
    console.log("  Sondeo solo peticiones que la colección declara sin escrituras y sin créditos.\n");
    const informe = await diagnosticar(ctx.client, { onPaso: (fase, que) => console.log(`  · ${que}`) });
    console.log("");
    for (const linea of formatearInforme(informe)) console.log(`  ${linea}`);
  });
}

async function itemCollection(ctx, refresh) {
  const { values: dotenv } = loadDotenv();
  const url = process.env[COLLECTION_URL_KEY] ?? dotenv[COLLECTION_URL_KEY];
  if (!url) throw new UsageError(`Falta ${COLLECTION_URL_KEY}: la URL de lectura de la colección publicada.`);

  await correrApi(ctx, { comando: "collection", flags: refresh ? { refresh: true } : { check: true } }, async () => {
    const publicada = await traerPublicada(url);
    const destino = refresh ? guardarCache(publicada) : join(tmpdir(), `sq-test-menu-${process.pid}.json`);
    const remoto = catalogoDe(publicada, destino);
    const derivas = comparar(cargarCatalogo(), remoto);
    if (!refresh) rmSync(destino, { force: true });
    for (const linea of formatearDerivas(derivas)) console.log(`  ${linea}`);
    if (derivas.length) ctx.sesion.huboError = true;
  });
}

/** Confirmación de un efecto, el equivalente en menú de `--yes`. */
async function confirmarEfecto(rl, que) {
  console.log(`\n   ⚠ ${que}.`);
  const r = (await rl.question("   ¿Seguro? [s/N]: ")).trim().toLowerCase();
  if (r === "s" || r === "si" || r === "sí") return true;
  console.log("   cancelado.");
  return false;
}

/** La pantalla de una sección de API, y el ruteo de sus ítems. */
async function pantallaSeccionApi(rl, sesion, nSeccion) {
  const seccion = SECCIONES_API[nSeccion - PRIMERA_SECCION_API];
  for (;;) {
    encabezado(sesion);
    console.log(`   ${nSeccion}. ${seccion.titulo}\n`);
    seccion.items.forEach((item, i) => {
      console.log(`   ${`${nSeccion}.${i + 1}`.padEnd(5)} ${item.etiqueta}`);
    });
    console.log(`\n   ${seccion.nota}\n`);
    console.log("   b. Volver     q. Salir");

    const op = (await rl.question("\n   > ")).trim().toLowerCase();
    if (op === "q") throw new SalirDelMenu();
    if (op === "b" || op === "") return;
    // El número solo, el `S.N` completo, o el alias: los tres llevan al mismo.
    const clave = /^\d+$/.test(op) ? `${nSeccion}.${op}` : op;
    const item = INDICE_API.get(clave);
    if (!item || item.seccion !== nSeccion) {
      console.log("   ✗ opción inválida.");
      continue;
    }
    await correrItemApi(rl, sesion, item);
    await rl.question("\n   [Enter para volver] ");
  }
}

/** Corre un ítem del carril API, venga del número o del alias. */
async function correrItemApi(rl, sesion, item) {
  try {
    const ctx = await contextoApi(rl, sesion, item.necesita);
    if (item.agente) return await itemAgente(ctx, item.agente);
    return await item.correr(ctx);
  } catch (err) {
    if (err instanceof CancelarAccion) return console.log("   cancelado.");
    sesion.huboError = true;
    console.error(`  ✗ ${err?.message ?? err}`);
  }
}
