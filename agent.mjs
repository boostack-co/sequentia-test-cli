/**
 * Los seis endpoints del carril agéntico, por nombre.
 *
 * El ejecutor genérico (`api run`) ya los puede correr. Estos existen por tres
 * razones que el genérico no puede dar:
 *
 *  1. **Validación local.** Los dos carriles tienen contratos que se parecen y
 *     no son iguales, y equivocarse es un 400 del servidor. Validar acá
 *     convierte ese 400 en un mensaje entendible sin salir a la red.
 *  2. **El encadenado `retrieve → feedback`.** Postman lo resuelve con
 *     variables de colección; un CLI es un proceso por invocación, así que
 *     hace falta guardar el `retrievalId` en algún lado — y acotarlo.
 *  3. **Los `prompts` que el menú necesita** para preguntar en orden (S8).
 *
 * Las asimetrías que hay que respetar, y que son 400 si se las ignora:
 *
 *   /agent/query     knowledgeBaseIds  ARRAY (1..10, únicos)   maxResults 1..20
 *   /agent/retrieve  knowledgeBaseId   singular                maxResults 1..50
 *   /agent/verify    knowledgeBaseId   singular                claimText <= 4000
 *
 * Por eso `api query` usa `--kbs` y el resto `--kb`: que la diferencia se vea
 * en el comando es más barato que descubrirla en un 400.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { UsageError, USER_ENV_FILE, intInRange, maxLen, oneOf, put, required } from "./commands.mjs";

/** Topes reales del servidor. No son política nuestra: son 400 si se pasan. */
export const QUERY_MAX_RESULTS = 20;
export const RETRIEVE_MAX_RESULTS = 50;
export const VERIFY_CLAIM_MAX = 4000;
export const QUERY_MAX_KBS = 10;
export const RATINGS = ["helpful", "not_helpful"];
export const PRIORITIES = ["low", "medium", "high"];

/**
 * Cuánto vale un `retrievalId` capturado. Es política de este CLI, no del
 * servidor: diez minutos es tiempo de sobra para que un humano lea una
 * respuesta y la califique, y poco para que el contexto se haya movido.
 */
export const RETRIEVAL_TTL_MS = 10 * 60 * 1000;

/** Dónde se recuerda el último `retrievalId`. Nunca guarda el token. */
export const STATE_FILE = join(dirname(USER_ENV_FILE), "estado.json");

// ---------------------------------------------------------------------------
// Estado entre invocaciones
// ---------------------------------------------------------------------------
export function leerEstado() {
  try {
    if (!existsSync(STATE_FILE)) return {};
    const v = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    // Un estado ilegible no puede tumbar un comando: es una comodidad, no un
    // dato del que dependa nada.
    return {};
  }
}

function guardarEstado(estado) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(estado, null, 2) + "\n", "utf8");
  } catch {
    // Idem: no poder recordar el id no invalida la recuperación que ya se hizo.
  }
}

/**
 * Recuerda un `retrievalId`, **solo si la respuesta fue exitosa**.
 *
 * Este carril incluye un `retrievalId` en sus cuerpos de 402, 500 y 502.
 * Guardar uno de esos ataría un feedback posterior a una consulta que nunca
 * produjo respuesta.
 *
 * Se guarda además contra QUÉ KB y contra QUÉ CELDA se capturó, porque el
 * servidor escribe la fila de feedback con lo que diga el cuerpo: calificar
 * después de cambiar de KB **funciona**, y la calificación aterriza en un panel
 * que esa recuperación nunca tocó.
 */
export function recordarRetrieval({ id, kb, kbId = null, celda }) {
  if (!id) return;
  const estado = leerEstado();
  // `kb` es lo que el usuario escribió (slug o UUID) y `kbId` lo que se mandó:
  // calificar después con cualquiera de los dos tiene que coincidir.
  estado.retrieval = { id, kb, kbId, celda, at: Date.now() };
  guardarEstado(estado);
}

/**
 * El `retrievalId` a usar, o un error que dice por qué no hay uno.
 * @throws {UsageError}
 */
export function retrievalUsable({ kb, celda }) {
  const r = leerEstado().retrieval;
  if (!r?.id) {
    throw new UsageError(
      "No hay ningún retrievalId recordado.\n" +
        "  Corré primero  api retrieve , o pasá --retrieval-id <id>.\n" +
        "  El campo es opcional en el esquema del servidor, así que un vacío se aceptaría y escribiría\n" +
        "  una fila de feedback ligada a nada, sesgando en silencio la analítica de utilidad.",
    );
  }
  const edad = Date.now() - Number(r.at ?? 0);
  if (!Number.isFinite(edad) || edad > RETRIEVAL_TTL_MS) {
    throw new UsageError(
      `El retrievalId recordado tiene ${Math.round(edad / 60000)} minutos y el límite son ${RETRIEVAL_TTL_MS / 60000}.\n` +
        "  Volvé a correr  api retrieve  antes de calificar, o pasá --retrieval-id explícitamente.",
    );
  }
  if (r.kb && kb && r.kb !== kb && r.kbId !== kb) {
    throw new UsageError(
      `El retrievalId se capturó contra la KB ${r.kb} y estás calificando contra ${kb}.\n` +
        "  El servidor escribiría la fila igual: la calificación aterrizaría en una KB que esa recuperación nunca tocó.",
    );
  }
  if (r.celda && celda && r.celda !== celda) {
    throw new UsageError(
      `El retrievalId se capturó contra ${r.celda} y ahora la celda es ${celda}.\n` +
        "  Un id de otra celda no identifica nada acá.",
    );
  }
  return r.id;
}

// ---------------------------------------------------------------------------
// Clave de idempotencia
// ---------------------------------------------------------------------------
/**
 * Deriva la clave del **cuerpo entero**.
 *
 * El requisito es que cubra exactamente lo mismo que el cuerpo: una clave más
 * estrecha devuelve 409 durante 24 h ante un cambio legítimo, y una más ancha
 * suprime observaciones que el contador de ocurrencias del servidor cuenta.
 * Derivarla del cuerpo lo cumple por construcción — reintentar lo mismo
 * deduplica, y mandar algo distinto es otra cosa.
 */
export function claveIdempotencia(prefijo, body) {
  return `${prefijo}-${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// El catálogo del carril
// ---------------------------------------------------------------------------
/** Lista separada por comas, sin vacíos y sin repetidos. */
function listaDe(valor, nombre, max) {
  const items = String(valor)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) throw new UsageError(`--${nombre} no puede estar vacío`);
  if (items.length > max) throw new UsageError(`--${nombre} acepta hasta ${max} valores (recibí ${items.length})`);
  if (new Set(items).size !== items.length) throw new UsageError(`--${nombre} tiene valores repetidos`);
  return items;
}

/**
 * Cada entrada declara lo mismo que una petición de la colección —para que la
 * guarda de `--yes` y el menú lean de un solo lugar— más su `build`.
 *
 * `rechaza` mapea flag → explicación para las opciones que existen en OTRO
 * comando del carril y aquí serían un 400. Va acá y no dentro de `build`
 * porque la validación de opciones desconocidas corre antes: un `throw` en
 * `build` sería inalcanzable.
 */
export const AGENT_COMMANDS = {
  retrieve: {
    metodo: "POST",
    ruta: "/agent/retrieve",
    help: "Recupera fragmentos con procedencia, sin generar nada.  --kb --q [--max-results 1-50]",
    opts: ["kb", "q", "max-results"],
    scopes: ["agent.retrieve", "rag.query"],
    persists: null,
    spendsCredits: true,
    captura: "retrievalId",
    build: (flags) =>
      put(
        {
          query: maxLen(required(flags, "q", "la consulta"), 10000, "q"),
          knowledgeBaseId: required(flags, "kb", "la knowledge base"),
        },
        "maxResults",
        intInRange(flags, "max-results", 1, RETRIEVE_MAX_RESULTS),
      ),
  },

  query: {
    metodo: "POST",
    ruta: "/agent/query",
    help: `El carril gestionado: Sequentia sintetiza.  --kbs a,b --q [--max-results 1-${QUERY_MAX_RESULTS}]`,
    opts: ["kbs", "q", "max-results"],
    scopes: ["agent.query", "rag.query"],
    persists: null,
    spendsCredits: true,
    // No es un capricho de nombres: este endpoint toma un ARRAY, y mandarle
    // `knowledgeBaseId` en singular es un 400 con el esquema estricto. El
    // mensaje genérico de opción desconocida nombra `--kbs`, pero no dice por
    // qué son dos flags distintos, que es justamente lo que este carril existe
    // para explicar sin salir a la red.
    rechaza: {
      kb: "api query usa --kbs (lista separada por comas), no --kb.\n" +
        "  Este endpoint toma un array de knowledge bases; el resto del carril toma una sola.",
    },
    build: (flags) => {
      const query = maxLen(required(flags, "q", "la consulta"), 10000, "q");
      const kbs = listaDe(required(flags, "kbs", "las knowledge bases"), "kbs", QUERY_MAX_KBS);
      const maxResults = intInRange(flags, "max-results", 1, QUERY_MAX_RESULTS);
      const body = { query, knowledgeBaseIds: kbs };
      if (maxResults !== undefined) body.options = { maxResults };
      return body;
    },
  },

  verify: {
    metodo: "POST",
    ruta: "/agent/verify",
    help: "Juzga si una afirmación está fundamentada en la KB.  --kb --claim",
    opts: ["kb", "claim"],
    scopes: ["agent.verify", "rag.query"],
    persists: null,
    spendsCredits: true,
    build: (flags) => ({
      // No se trunca: un veredicto sobre los primeros 4000 caracteres no cubre
      // lo que el agente va a enviar.
      claimText: maxLen(required(flags, "claim", "la afirmación a verificar"), VERIFY_CLAIM_MAX, "claim"),
      knowledgeBaseId: required(flags, "kb", "la knowledge base"),
    }),
  },

  "index-status": {
    metodo: "GET",
    ruta: (flags) => `/agent/index-status/${encodeURIComponent(required(flags, "kb", "la knowledge base"))}`,
    help: "Cuánto de la KB está indexado.  --kb",
    opts: ["kb"],
    scopes: ["agent.index_status", "kb.read"],
    persists: null,
    spendsCredits: false,
    build: () => undefined,
  },

  "gap-report": {
    metodo: "POST",
    ruta: "/agent/gap-report",
    help: "Reporta que la KB no cubre algo.  --kb --q [--context] [--title] [--priority low|medium|high] --yes",
    opts: ["kb", "q", "context", "title", "priority"],
    scopes: ["agent.gap_report", "gaps.write"],
    persists: "una fila de hueco de conocimiento en la cola de triage",
    spendsCredits: false,
    idempotencia: "sq-test-gap",
    build: (flags) => {
      const hueco = put(
        put(put({ query: maxLen(required(flags, "q", "la consulta que no se pudo cubrir"), 10000, "q") }, "context", flags.context), "suggestedTitle", flags.title),
        "priority",
        oneOf(flags, "priority", PRIORITIES),
      );
      return { knowledgeBaseId: required(flags, "kb", "la knowledge base"), gaps: [hueco] };
    },
  },

  feedback: {
    metodo: "POST",
    ruta: "/agent/feedback",
    help: "Califica una recuperación que un humano ya leyó.  --kb --rating helpful|not_helpful [--retrieval-id] [--reason] [--comment] --yes",
    opts: ["kb", "rating", "retrieval-id", "reason", "comment"],
    // El único endpoint del carril SIN scope de reserva: `agent.feedback` es la
    // única cadena que lo abre, así que una key que corre todo lo demás puede
    // fallar exactamente acá.
    scopes: ["agent.feedback"],
    persists: "una fila de feedback de utilidad en la analítica de la KB",
    spendsCredits: false,
    idempotencia: "sq-test-feedback",
    /** Necesita el id recordado, así que recibe el contexto además de los flags. */
    build: (flags, { celda } = {}) => {
      const kb = required(flags, "kb", "la knowledge base");
      required(flags, "rating", "helpful o not_helpful");
      const rating = oneOf(flags, "rating", RATINGS);
      // Sin id explícito se usa el recordado, que llega con sus tres guardas.
      const retrievalId = flags["retrieval-id"] || retrievalUsable({ kb, celda });
      return put(
        put(
          { knowledgeBaseId: kb, retrievalId, rating },
          "reason",
          flags.reason === undefined ? undefined : maxLen(flags.reason, 64, "reason"),
        ),
        "comment",
        flags.comment === undefined ? undefined : maxLen(flags.comment, 2000, "comment"),
      );
    },
  },
};

/** ¿Este comando del carril necesita `--yes`? Misma regla que en la colección. */
export function agentNecesitaConfirmacion(spec) {
  return Boolean(spec.persists) || spec.spendsCredits;
}
