/**
 * Catálogo de comandos y utilidades compartidas por los dos frentes:
 * el CLI (`sq-test.mjs`) y el menú (`menu.mjs`).
 *
 * Vive en un módulo aparte por una razón concreta: el menú imprime el comando
 * equivalente a cada acción, y esa línea solo es confiable si ambos frentes
 * arman los argumentos con el MISMO código. Dos implementaciones del mismo
 * comando convertirían ese "comando ejecutado" en una promesa que se rompe sola.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeApiBase } from "./api-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Error de uso o configuración: se imprime sin stack y sale con 2. */
export class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------
/** El archivo de entrada del CLI. El comando reproducible siempre lo nombra a él. */
const CLI_FILE = "sq-test.mjs";

/** El servidor MCP de Sequentia: el único endpoint que necesita un cliente. */
export const DEFAULT_URL = "https://mcp.sequentia.co/mcp";

/**
 * Modo de consulta por defecto. El servidor usa `standard` si no se manda
 * nada; este banco manda `fast` explicitamente porque su uso normal es
 * explorar, y ahi la latencia importa mas que la profundidad. Se envia de
 * verdad (no es solo un texto en el prompt), asi que el comando impreso y
 * lo que corre coinciden.
 */
export const DEFAULT_MODE = "fast";

/** Modos que acepta query_knowledge_base. */
export const QUERY_MODES = ["fast", "standard", "precise"];

/** Claves del `.env`. `SQ_TEST_URL` solo hace falta contra otro despliegue. */
export const TOKEN_KEY = "SQ_TEST_TOKEN";
export const URL_KEY = "SQ_TEST_URL";

/**
 * El origen de la celda para el carril REST (`/api/v1`).
 *
 * No tiene default, y no es un olvido: el endpoint MCP es un gateway universal
 * —el mismo para todos—, pero la API REST se sirve desde la celda del cliente,
 * así que no hay ningún valor razonable que poner. Un default acá sería un host
 * ajeno recibiendo tu API key como bearer token.
 */
export const API_URL_KEY = "SQ_TEST_API_URL";

/**
 * La URL de lectura de la colección publicada, con su access key.
 *
 * Tampoco tiene default, y ya no es porque falte publicar: la colección está
 * publicada. Es que la URL de lectura lleva una access key, y **GitHub bloquea
 * el push** de un repo que la contenga — push protection la detecta por nombre.
 * Se puede desbloquear a mano, pero un token en un repo público es algo que
 * alguien rota algún día, y ese día `--check` se rompe sin que nadie lo haya
 * tocado. El workspace y el id sí están en `collection/PUBLISHING.md`.
 *
 * El endpoint anónimo (`www.postman.com/collections/<uid>`) tampoco sirve de
 * default aunque el workspace sea público: degrada el schema a v2.0.0 y la
 * comparación quedaría contrastando dos formatos distintos.
 *
 * La API key de Postman de quien publica no entra al repo bajo ninguna forma, y
 * el job `secretos` del CI la rechazaría.
 */
export const COLLECTION_URL_KEY = "SQ_TEST_COLLECTION_URL";

// ---------------------------------------------------------------------------
// Parser de .env
// ---------------------------------------------------------------------------
/**
 * Corta en el PRIMER `=` y conserva el resto verbatim. Un parser que hace
 * `split("=")` y se queda con `[1]` trunca los valores que contienen `=`
 * (base64, JWT); ese error llegó a corromper una clave en producción.
 */
export function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    // Solo se quitan las comillas si abren Y cierran.
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Config del usuario, la que sobrevive a reinstalar: `~/.config/sq-test/.env`. */
export const USER_ENV_FILE = join(homedir(), ".config", "sq-test", ".env");

/**
 * Dónde se busca el `.env`, de MENOR a MAYOR prioridad.
 *
 * Se **fusionan**, no se elige el primero que exista: si el directorio actual
 * tiene un `.env` de otro proyecto (sin claves `SQ_TEST_*`), no debe tapar la
 * config del usuario y dejar el token "faltante".
 *
 * El directorio de instalación va último a propósito: con `npm install -g` cae
 * dentro de `node_modules`, se pierde al actualizar y no es lugar para un
 * secreto. Sigue soportado para quien trabaje desde el repo.
 */
export function envFileCandidates() {
  const files = [resolve(HERE, ".env"), USER_ENV_FILE, resolve(process.cwd(), ".env")];
  if (process.env.SQ_TEST_ENV_FILE) files.push(resolve(process.env.SQ_TEST_ENV_FILE));
  // Corriendo desde el repo, el directorio de instalación y el actual son el
  // mismo archivo: sin deduplicar se leía dos veces y se reportaba repetido.
  return [...new Set(files)];
}

/** @returns {{values: object, files: string[]}} claves fusionadas y de dónde salieron. */
export function loadDotenv() {
  const values = {};
  const files = [];
  for (const f of envFileCandidates()) {
    if (!existsSync(f)) continue;
    Object.assign(values, parseEnvFile(f));
    files.push(f);
  }
  return { values, files };
}

/** Precedencia: flag > variable de proceso > .env (fusionados) > default. */
export function resolveConfig(flags = {}) {
  const { values: dotenv, files: envFiles } = loadDotenv();
  const pick = (key) => process.env[key] ?? dotenv[key];

  const url = flags.url ?? pick(URL_KEY) ?? DEFAULT_URL;
  const token = flags.token ?? pick(TOKEN_KEY);

  if (!token) {
    throw new UsageError(
      "Falta la API key.\n" +
        `  Corré  sq-test init  para crear ${USER_ENV_FILE}, y poné ahí ${TOKEN_KEY}.\n` +
        `  También sirve exportar ${TOKEN_KEY} como variable de entorno, o pasar --token.` +
        (envFiles.length ? `\n  Config leída de: ${envFiles.join(", ")}` : "\n  (no se encontró ningún .env)"),
    );
  }
  return { url, token, envFiles };
}

/**
 * Config del carril REST. Se resuelve aparte de `resolveConfig` a propósito:
 * son dos endpoints distintos, y exigir el de la API para correr un comando MCP
 * (o al revés) obligaría a configurar algo que ese comando no usa.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.requireToken] `api health` corre sin credencial, que es
 *   justamente lo que lo vuelve el primer diagnóstico: si falla, es la URL.
 */
export function resolveApiConfig(flags = {}, { requireToken = true } = {}) {
  const { values: dotenv, files: envFiles } = loadDotenv();
  const pick = (key) => process.env[key] ?? dotenv[key];

  const raw = flags["api-url"] ?? pick(API_URL_KEY);
  if (!raw) {
    throw new UsageError(
      "Falta la URL de la celda para el carril API.\n" +
        `  Poné ${API_URL_KEY} en ${USER_ENV_FILE}, exportala, o pasá --api-url.\n` +
        "  Es el origen DIRECTO de tu celda (algo como https://tu-celda.example),\n" +
        "  sin barra final y sin /api/v1: cada ruta ya lo agrega.\n" +
        `  No es el endpoint MCP (${URL_KEY}), que suele ser otro host.` +
        (envFiles.length ? `\n  Config leída de: ${envFiles.join(", ")}` : "\n  (no se encontró ningún .env)"),
    );
  }

  let apiUrl;
  try {
    apiUrl = normalizeApiBase(raw);
  } catch (err) {
    // Una URL ilegible es un error de configuración (exit 2), no de transporte:
    // no se llegó a hablar con nadie.
    throw new UsageError(`${API_URL_KEY} no sirve: ${err.message}`);
  }

  const token = flags.token ?? pick(TOKEN_KEY) ?? null;
  if (requireToken && !token) {
    throw new UsageError(
      "Falta la API key.\n" +
        `  Corré  sq-test init  para crear ${USER_ENV_FILE}, y poné ahí ${TOKEN_KEY}.\n` +
        `  También sirve exportar ${TOKEN_KEY} como variable de entorno, o pasar --token.` +
        (envFiles.length ? `\n  Config leída de: ${envFiles.join(", ")}` : "\n  (no se encontró ningún .env)"),
    );
  }
  return { apiUrl, token, envFiles };
}

/**
 * Plantilla del `.env` del usuario. Se genera en código y no copiando
 * `.env.example`, para que no dependa de que ese archivo viaje en el paquete
 * instalado ni pueda quedar desfasada.
 */
export function plantillaEnv() {
  return [
    "# Test de Integraciones SEQUENTIA — configuración del usuario.",
    "# Este archivo NO se versiona: contiene tu API key.",
    "",
    "# Tu API key de Sequentia.",
    `${TOKEN_KEY}=`,
    "",
    "# El origen DIRECTO de tu celda, para el carril API (/api/v1).",
    "# Sin barra final y sin /api/v1: cada ruta ya lo agrega.",
    "# No es el endpoint MCP de abajo: suele ser otro host.",
    `${API_URL_KEY}=`,
    "",
    "# Opcional: la colección publicada en Postman, para  api collection --check .",
    "# Lleva su access key, que es de solo lectura y de una sola colección.",
    `# ${COLLECTION_URL_KEY}=`,
    "",
    "# Para  api loop : TU modelo. Cualquier /chat/completions compatible con",
    "# OpenAI sirve — vLLM, Ollama, LM Studio, OpenRouter, OpenAI directo.",
    "# Azure no entra en este shape: necesita endpoint, apiVersion y deployment.",
    "# SQ_TEST_LLM_URL=http://localhost:11434/v1/chat/completions",
    "# SQ_TEST_LLM_MODEL=",
    "# SQ_TEST_LLM_KEY=",
    "",
    "# Opcional: solo si apuntás a un despliegue propio de Sequentia.",
    `# ${URL_KEY}=${DEFAULT_URL}`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Validadores (espejo de los bounds reales del inputSchema del servidor)
// ---------------------------------------------------------------------------
export function required(flags, name, what) {
  const v = flags[name];
  if (v === undefined || v === "") throw new UsageError(`Falta --${name} (${what})`);
  return String(v);
}

export function maxLen(value, max, name) {
  if (value.length > max) {
    throw new UsageError(`--${name} tiene ${value.length} caracteres; el servidor acepta hasta ${max}`);
  }
  return value;
}

export function intInRange(flags, name, min, max) {
  if (flags[name] === undefined) return undefined;
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`--${name} debe ser un entero entre ${min} y ${max} (recibí "${flags[name]}")`);
  }
  return n;
}

export function oneOf(flags, name, allowed) {
  if (flags[name] === undefined) return undefined;
  const v = String(flags[name]);
  if (!allowed.includes(v)) {
    throw new UsageError(`--${name} debe ser uno de: ${allowed.join(", ")} (recibí "${v}")`);
  }
  return v;
}

/** Agrega la clave solo si el valor está definido: el servidor tiene defaults propios. */
export function put(target, key, value) {
  if (value !== undefined && value !== "") target[key] = value;
  return target;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** KB ficticia para la pasada de validación previa a resolver el slug. Nunca se envía. */
export const PLACEHOLDER_KB_ID = "00000000-0000-0000-0000-000000000000";

/** Acepta UUID o slug/nombre: si no es UUID, lo resuelve por list_knowledge_bases. */
export async function resolveKbId(client, raw) {
  if (UUID_RE.test(raw)) return raw;
  const { data } = await client.call("list_knowledge_bases", {});
  const kbs = Array.isArray(data) ? data : [];
  const needle = raw.toLowerCase();
  const hit = kbs.find((kb) => kb.slug?.toLowerCase() === needle || kb.name?.toLowerCase() === needle);
  if (!hit) {
    const names = kbs.map((kb) => kb.slug ?? kb.name).join(", ") || "(ninguna)";
    throw new UsageError(`No encontré la KB "${raw}". Disponibles: ${names}`);
  }
  return hit.id;
}

// ---------------------------------------------------------------------------
// Formato de salida
// ---------------------------------------------------------------------------
export const short = (id) => (typeof id === "string" && id.length > 8 ? `${id.slice(0, 8)}…` : String(id ?? ""));
export const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Milisegundos legibles: "820 ms" abajo del segundo, "3.21 s" arriba. */
export function formatMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "?";
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`;
}

/** Enmascara un token para mostrarlo: conserva el prefijo y los últimos 4. */
export function maskToken(token) {
  const t = String(token ?? "");
  if (!t) return "(sin token)";
  const cut = t.lastIndexOf("_");
  const prefix = cut > 0 ? t.slice(0, cut + 1) : t.slice(0, 8);
  return `${prefix}…${t.slice(-4)}`;
}

export function printTable(rows, columns) {
  if (rows.length === 0) {
    console.log("(sin resultados)");
    return;
  }
  const widths = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => String(c.get(r) ?? "").length)));
  const line = (cells) => cells.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  ").trimEnd();
  console.log(line(columns.map((c) => c.header)));
  console.log(line(widths.map((w) => "─".repeat(w))));
  for (const row of rows) console.log(line(columns.map((c) => c.get(row))));
}

export function printKbs(kbs) {
  printTable(kbs, [
    { header: "ID", get: (k) => short(k.id) },
    { header: "NOMBRE", get: (k) => k.name },
    { header: "SLUG", get: (k) => k.slug },
    { header: "LANG", get: (k) => k.defaultLanguage },
    { header: "ARTS", get: (k) => k.articleCount },
  ]);
  console.log(`\n${kbs.length} knowledge base(s).`);
}

/** Salida legible de query_knowledge_base / get_canonical_answer. */
export function printAnswer(payload) {
  if (payload?.answer) {
    console.log(payload.answer);
  } else if (payload?.aiAnswersEnabled === false) {
    // Este caso llega SIN isError: el workspace tiene las respuestas IA apagadas.
    console.log(`(sin respuesta: las respuestas con IA están deshabilitadas en el workspace — reason=${payload.reason ?? "?"})`);
  } else if (payload?.answer === null) {
    console.log(`(sin respuesta${payload?.reason ? `: ${payload.reason}` : ""})`);
  }
  const sources = payload?.sources ?? [];
  if (sources.length) {
    console.log(`\n── Fuentes (${sources.length}) ──`);
    sources.forEach((s, i) => {
      console.log(`\n[${i + 1}] ${s.title ?? "(sin título)"}`);
      if (s.articleSlug) console.log(`    slug:    ${s.articleSlug}`);
      if (s.articleId) console.log(`    article: ${s.articleId}`);
      if (s.knowledgeBaseName) console.log(`    kb:      ${s.knowledgeBaseName}`);
      if (s.excerpt) console.log(`    ${clip(s.excerpt, 180)}`);
    });
  }
  const meta = [];
  if (payload?.requestedMode) meta.push(`modo pedido=${payload.requestedMode}`);
  if (payload?.actualMode) meta.push(`modo real=${payload.actualMode}`);
  if (payload?.cached !== undefined) meta.push(`cache=${payload.cached}`);
  if (payload?.latencyMs !== undefined) meta.push(`latencia=${Math.round(Number(payload.latencyMs))}ms`);
  if (meta.length) console.log(`\n(${meta.join(" · ")})`);
  // Con credencial de máquina el modo `precise` degrada solo a `standard`.
  if (payload?.fallbackReason) console.log(`⚠ el servidor degradó el modo: ${payload.fallbackReason}`);
}

export function printArticles(payload) {
  // search_articles devuelve un array pelado, salvo que el filtro --category
  // no matchee nada: ahí devuelve { results, _warning }.
  const list = Array.isArray(payload) ? payload : (payload?.results ?? payload?.articles ?? []);
  if (payload?._warning) console.log(`⚠ ${payload._warning}\n`);
  if (!Array.isArray(list) || list.length === 0) {
    console.log("(sin resultados)");
    return;
  }
  list.forEach((a, i) => {
    console.log(`\n[${i + 1}] ${a.title ?? "(sin título)"}${a.status ? `  · ${a.status}` : ""}`);
    if (a.slug) console.log(`    slug: ${a.slug}`);
    if (a.id ?? a.articleId) console.log(`    id:   ${a.id ?? a.articleId}`);
    const body = a.excerpt ?? a.snippet ?? a.summary;
    if (body) console.log(`    ${clip(body, 180)}`);
  });
  console.log(`\n${list.length} artículo(s).`);
}

/** Fallback: JSON indentado. Sirve para todo lo que no tiene formato dedicado. */
export function printPretty(payload) {
  if (payload === null || payload === undefined) {
    console.log("(respuesta vacía)");
  } else if (typeof payload === "string") {
    console.log(payload);
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------
/**
 * Herramientas que la doc declara como consumidoras de crédito o que escriben
 * en el audit trail: exigen --yes. Va indexado por NOMBRE DE HERRAMIENTA, no
 * por subcomando, para que la escotilla `call` quede cubierta por la misma
 * guarda. `execute_action` está acá aunque hoy no exista en el deployment: si
 * algún día se habilita, nace protegida.
 */
export const SIDE_EFFECT_TOOLS = {
  verify_claim: "consume un crédito y escribe en el registro de auditoría",
  record_decision: "escribe en el registro de auditoría del workspace",
  execute_action: "ejecuta una acción externa y consume un crédito",
};

/**
 * Cada entrada declara:
 *   tool     nombre MCP real
 *   label    texto corto para el menú
 *   opts     opciones válidas (las rechaza `assertKnownFlags` del CLI)
 *   help     línea de la ayuda del CLI
 *   needsKb  si `--kb` es obligatorio
 *   prompts  qué pedir en el menú, en orden. `kind: "kb"` hace que el menú
 *            liste las KBs numeradas en vez de pedir un UUID a mano.
 *   build    arma los argumentos MCP y VALIDA (única fuente de verdad)
 *   print    salida legible
 */
export const COMMANDS = {
  "list-kbs": {
    tool: "list_knowledge_bases",
    label: "Listar knowledge bases",
    opts: [],
    help: "Lista las knowledge bases accesibles con tu API key.",
    prompts: [],
    build: () => ({}),
    print: printKbs,
  },

  "query-kb": {
    tool: "query_knowledge_base",
    label: "Consultar una KB (RAG)",
    opts: ["kb", "q", "mode", "language", "limit"],
    help: "Consulta una KB por RAG.  --kb --q [--mode fast|standard|precise, default fast] [--language] [--limit 1-20]",
    needsKb: true,
    prompts: [
      { opt: "kb", label: "Knowledge base", kind: "kb", required: true },
      { opt: "q", label: "Pregunta", required: true, maxLen: 2000 },
      { opt: "mode", label: "Modo", choices: QUERY_MODES, default: DEFAULT_MODE },
      { opt: "limit", label: "Fuentes", range: [1, 20], default: 5 },
      { opt: "language", label: "Idioma", hint: "en, es… (Enter para omitir)" },
    ],
    build: (flags, kbId) =>
      put(
        put(put({ knowledgeBaseId: kbId, question: maxLen(required(flags, "q", "la pregunta"), 2000, "q") }, "mode", oneOf(flags, "mode", QUERY_MODES) ?? DEFAULT_MODE), "language", flags.language),
        "limit",
        intInRange(flags, "limit", 1, 20),
      ),
    print: printAnswer,
  },

  search: {
    tool: "search_articles",
    label: "Buscar artículos",
    opts: ["kb", "q", "category", "status", "limit"],
    help: "Busca artículos en una KB.  --kb --q [--category] [--status] [--limit 1-50]",
    needsKb: true,
    prompts: [
      { opt: "kb", label: "Knowledge base", kind: "kb", required: true },
      { opt: "q", label: "Búsqueda", required: true, maxLen: 500 },
      { opt: "limit", label: "Máximo de resultados", range: [1, 50], default: 10 },
      { opt: "status", label: "Estado", choices: ["draft", "review", "published", "deprecated"], hint: "Enter para omitir; el almacenamiento solo devuelve published" },
      { opt: "category", label: "ID de categoría", hint: "Enter para omitir" },
    ],
    build: (flags, kbId) =>
      put(
        put(put({ knowledgeBaseId: kbId, query: maxLen(required(flags, "q", "la búsqueda"), 500, "q") }, "categoryId", flags.category), "status", oneOf(flags, "status", ["draft", "review", "published", "deprecated"])),
        "limit",
        intInRange(flags, "limit", 1, 50),
      ),
    print: printArticles,
  },

  "get-article": {
    tool: "get_article",
    label: "Ver un artículo",
    opts: ["kb", "id", "slug"],
    help: "Trae un artículo completo.  --kb  y  --id <articleId>  o  --slug <articleSlug>",
    needsKb: true,
    prompts: [
      { opt: "kb", label: "Knowledge base", kind: "kb", required: true },
      { opt: "slug", label: "Slug del artículo", hint: "o dejalo vacío y usá el ID" },
      { opt: "id", label: "ID del artículo", hint: "solo si no pusiste slug" },
    ],
    build: (flags, kbId) => {
      if (!flags.id && !flags.slug) throw new UsageError("Necesito --id <articleId> o --slug <articleSlug>");
      return put(put({ knowledgeBaseId: kbId }, "articleId", flags.id), "articleSlug", flags.slug);
    },
    print: printPretty,
  },

  "list-categories": {
    tool: "list_categories",
    label: "Listar categorías",
    opts: ["kb"],
    help: "Lista las categorías de una KB, con su jerarquía.  --kb",
    needsKb: true,
    prompts: [{ opt: "kb", label: "Knowledge base", kind: "kb", required: true }],
    build: (flags, kbId) => ({ knowledgeBaseId: kbId }),
    print: printPretty,
  },

  "verify-claim": {
    tool: "verify_claim",
    label: "Verificar una afirmación",
    opts: ["kb", "claim", "articles"],
    help: "Verifica un borrador de respuesta contra la KB.  --kb --claim [--articles a,b,c]  (requiere --yes)",
    needsKb: true,
    prompts: [
      { opt: "kb", label: "Knowledge base", kind: "kb", required: true },
      { opt: "claim", label: "Afirmación a verificar", required: true, maxLen: 4000 },
      { opt: "articles", label: "Limitar a artículos", hint: "IDs separados por coma (Enter para omitir)" },
    ],
    build: (flags, kbId) => {
      const args = { knowledgeBaseId: kbId, claimText: maxLen(required(flags, "claim", "el texto a verificar"), 4000, "claim") };
      if (flags.articles) {
        const ids = String(flags.articles).split(",").map((s) => s.trim()).filter(Boolean);
        if (ids.length > 50) throw new UsageError(`--articles acepta hasta 50 IDs (recibí ${ids.length})`);
        if (ids.length) args.articleIds = ids;
      }
      return args;
    },
    print: printPretty,
  },

  "check-freshness": {
    tool: "check_freshness",
    label: "Chequear vigencia",
    opts: ["kb", "article"],
    help: "Chequea si un artículo sigue vigente.  --kb --article <articleId>",
    needsKb: true,
    prompts: [
      { opt: "kb", label: "Knowledge base", kind: "kb", required: true },
      { opt: "article", label: "ID del artículo", required: true },
    ],
    build: (flags, kbId) => ({ knowledgeBaseId: kbId, articleId: required(flags, "article", "el ID del artículo") }),
    print: printPretty,
  },

  canonical: {
    tool: "get_canonical_answer",
    label: "Respuesta canónica",
    opts: ["kb", "q", "language"],
    help: "Respuesta oficial y fundamentada de la KB.  --kb --q [--language]",
    needsKb: true,
    prompts: [
      { opt: "kb", label: "Knowledge base", kind: "kb", required: true },
      { opt: "q", label: "Pregunta", required: true, maxLen: 2000 },
      { opt: "language", label: "Idioma", hint: "en, es… (Enter para omitir)" },
    ],
    build: (flags, kbId) =>
      put({ knowledgeBaseId: kbId, question: maxLen(required(flags, "q", "la pregunta"), 2000, "q") }, "language", flags.language),
    print: printAnswer,
  },

  "record-decision": {
    tool: "record_decision",
    label: "Registrar decisión",
    opts: ["decision", "kb", "claim", "verdict", "evidence"],
    help: "Registra una decisión del agente.  --decision sent|reformulated|escalated|blocked [--kb] [--claim] [--verdict] [--evidence <json>]  (requiere --yes)",
    prompts: [
      { opt: "decision", label: "Decisión", choices: ["sent", "reformulated", "escalated", "blocked"], required: true },
      { opt: "kb", label: "Knowledge base", kind: "kb", hint: "Enter para omitir" },
      { opt: "claim", label: "Afirmación", maxLen: 4000, hint: "Enter para omitir" },
      { opt: "verdict", label: "Veredicto", hint: "el de verify_claim (Enter para omitir)" },
      { opt: "evidence", label: "Evidencia", kind: "json", hint: "JSON (Enter para omitir)" },
    ],
    build: (flags, kbId) => {
      const decision = oneOf(flags, "decision", ["sent", "reformulated", "escalated", "blocked"]);
      if (!decision) throw new UsageError("Falta --decision (sent|reformulated|escalated|blocked)");
      const args = put(put({ decision }, "knowledgeBaseId", kbId), "verdict", flags.verdict);
      if (flags.claim) args.claimText = maxLen(String(flags.claim), 4000, "claim");
      if (flags.evidence) {
        try {
          args.evidence = JSON.parse(String(flags.evidence));
        } catch (err) {
          throw new UsageError(`--evidence debe ser JSON válido: ${err.message}`);
        }
      }
      return args;
    },
    print: printPretty,
  },

  glossary: {
    tool: "get_workspace_glossary",
    label: "Glosario del workspace",
    opts: ["kb", "language"],
    help: "Terminología curada del workspace.  [--kb] [--language]",
    prompts: [
      { opt: "kb", label: "Knowledge base", kind: "kb", hint: "Enter para todo el workspace" },
      { opt: "language", label: "Idioma", hint: "en, es… (Enter para omitir)" },
    ],
    build: (flags, kbId) => put(put({}, "knowledgeBaseId", kbId), "language", flags.language),
    print: printPretty,
  },

  context: {
    tool: "get_workspace_context",
    label: "Contexto del workspace",
    opts: ["kb"],
    help: "Contexto del workspace: nombre, idiomas, KBs y árbol de categorías.  [--kb]",
    prompts: [{ opt: "kb", label: "Knowledge base", kind: "kb", hint: "Enter para la primera accesible" }],
    build: (flags, kbId) => put({}, "knowledgeBaseId", kbId),
    print: printPretty,
  },

  prefs: {
    tool: "get_user_preferences",
    label: "Preferencias de operación",
    opts: [],
    help: "Preferencias de operación que el agente debería honrar.",
    prompts: [],
    build: () => ({}),
    print: printPretty,
  },
};

// ---------------------------------------------------------------------------
// El comando reproducible
// ---------------------------------------------------------------------------
/**
 * Un valor necesita comillas si trae algo que la shell interpretaría.
 *
 * Se usan comillas SIMPLES, no dobles. Dentro de dobles, bash interactivo
 * sigue expandiendo el historial: una pregunta como `What! now?` daba
 * `event not found` al pegar el comando. Entre simples no se expande nada,
 * y una comilla simple embebida se escapa con el clásico `'\''`.
 */
function quoteArg(value) {
  const s = String(value);
  if (s !== "" && /^[A-Za-z0-9._/@:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Emite una opción con su valor. Los valores que empiezan con `-` van con la
 * forma `--opt=valor`: el parser trata a propósito un `-algo` suelto como otra
 * opción, así que `--q --dry-run` fallaría con "falta el valor" y el comando
 * anunciado como reproducible no reproduciría nada.
 */
function emitOption(parts, key, value) {
  const s = String(value);
  if (s.startsWith("-")) parts.push(`--${key}=${quoteArg(s)}`);
  else parts.push(`--${key}`, quoteArg(s));
}

/**
 * Con qué se invoca el CLI, para que el comando impreso se pueda pegar.
 *
 * Instalado con `npm install -g`, el script vive en `node_modules` y se lanza
 * por el shim `sq-test`: imprimir `node sq-test.mjs …` sería una ruta que no
 * existe en el directorio del usuario. Desde el repo, en cambio, `sq-test` no
 * está en el PATH y hay que decir `node sq-test.mjs`.
 *
 * `SQ_TEST_CMD` lo fuerza, por si alguna instalación no encaja en la heurística.
 */
export function invocationPrefix() {
  if (process.env.SQ_TEST_CMD) return process.env.SQ_TEST_CMD;
  const script = process.argv[1] ?? "";
  if (script.includes("node_modules")) return "sq-test";
  const base = basename(script);
  // Si nos lanzó el shim del PATH (sin extensión), ese es el nombre a imprimir.
  if (base && !base.endsWith(".mjs")) return base;
  // Desde el código, el comando reproducible es SIEMPRE el del CLI, no el del
  // archivo que se ejecutó: por `menu-smoke.mjs` se imprimía
  // `node menu-smoke.mjs list-kbs`, un comando que no hace eso.
  return `node ${CLI_FILE}`;
}

/**
 * Arma la línea de comando equivalente a una ejecución. Se alimenta de los
 * MISMOS flags que recibe `build`, así que lo que se imprime es lo que corrió.
 *
 * Nunca incluye `--token`: el comando se muestra en pantalla y se copia.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.needsYes] agrega `--yes` para las herramientas con efectos
 * @param {string} [opts.url] endpoint activo; se emite como `--url` solo si NO es
 *   el default. Omitirlo hacía que un comando ejecutado contra un endpoint
 *   propio, al pegarlo en otra terminal, pegara en el de Sequentia.
 */
export function buildCommandLine(commandName, flags = {}, { needsYes = false, url } = {}) {
  const parts = invocationPrefix().split(" ");
  if (url && url !== DEFAULT_URL) emitOption(parts, "url", url);
  parts.push(commandName);

  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined || value === "" || key === "token" || key === "url") continue;
    if (value === true) parts.push(`--${key}`);
    else if (value !== false) emitOption(parts, key, value);
  }
  if (needsYes && !flags.yes) parts.push("--yes");
  return parts.join(" ");
}
