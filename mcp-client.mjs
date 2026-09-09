/**
 * Cliente MCP (Streamable HTTP) para el servidor de Sequentia.
 *
 * Sin dependencias: usa `fetch` y `AbortSignal` nativos de Node >= 18.
 *
 * Particularidades del servidor, verificadas en vivo contra
 * https://mcp.sequentia.co/mcp — ver README.md:
 *
 *  1. Es STATEFUL: un `tools/call` pelado devuelve 400 "Server not initialized".
 *     Hay que hacer initialize -> notifications/initialized -> tools/*.
 *  2. Responde `text/event-stream`, no JSON: el cuerpo hay que parsearlo como SSE.
 *  3. El `initialize` devuelve la cabecera `mcp-session-id`, que va en cada
 *     request posterior.
 *  4. Los errores de herramienta NO son errores JSON-RPC: llegan como
 *     `result.isError === true` con el texto en `result.content[0].text`.
 *  5. El payload útil está doblemente serializado: `result.content[0].text` es
 *     un string JSON.
 */

export const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "sq-test-cli", version: "1.0.0" };

/** Intentos de DELETE por sesión: el 400/404 suele ser ruteo, no inexistencia. */
const DELETE_ATTEMPTS = 3;

/** Falla del transporte, de autenticación o del propio JSON-RPC. */
export class McpTransportError extends Error {
  constructor(message, { status = null, body = null, wwwAuthenticate = null } = {}) {
    super(message);
    this.name = "McpTransportError";
    this.status = status;
    this.body = body;
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

/** La herramienta corrió pero devolvió `isError: true`. */
export class McpToolError extends Error {
  constructor(message, { tool = null, content = null, envelope = null } = {}) {
    super(message);
    this.name = "McpToolError";
    this.tool = tool;
    this.content = content;
    // El sobre JSON-RPC completo, para que `--raw` siga sirviendo cuando la
    // herramienta falla — que es justo cuando más se necesita depurar.
    this.envelope = envelope;
  }
}

/**
 * Parsea un cuerpo SSE (`event: message` + `data: {...}`) y devuelve el frame
 * cuyo `id` coincide con el pedido. Si no hay coincidencia, devuelve el primer
 * frame que traiga `result` o `error` — así seguimos funcionando si el servidor
 * intercala notificaciones.
 */
export function parseSseFrames(text, wantedId) {
  const frames = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.startsWith("data:")) continue;
    const payload = rawLine.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      frames.push(JSON.parse(payload));
    } catch {
      // Un frame ilegible no debe tumbar la respuesta entera.
    }
  }
  if (wantedId !== undefined && wantedId !== null) {
    const match = frames.find((f) => f.id === wantedId);
    if (match) return match;
  }
  return frames.find((f) => "result" in f || "error" in f) ?? frames[0] ?? null;
}

export class SequentiaMcpClient {
  /**
   * @param {object} opts
   * @param {string} opts.url        endpoint completo, p. ej. https://mcp.sequentia.co/mcp
   * @param {string} opts.token      API key (`sk_live_...`) o access token OAuth
   * @param {number} [opts.timeoutMs]
   * @param {(msg: string) => void} [opts.onDebug] traza a stderr (--verbose)
   */
  constructor({ url, token, timeoutMs = 120_000, onDebug = null }) {
    if (!url) throw new McpTransportError("Falta la URL del servidor MCP");
    if (!token) throw new McpTransportError("Falta el token del servidor MCP");
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.onDebug = onDebug;
    this.sessionId = null;
    this.serverInfo = null;
    this.rateLimit = null;
    this._nextId = 1;
    // Toda sesión abierta por este cliente, incluidas las que quedaron
    // huérfanas tras un re-handshake. close() las cierra a todas.
    this.#knownSessions = new Set();
    this.#connecting = null;
  }

  /** @type {Set<string>} */
  #knownSessions;

  /** Handshake en vuelo, compartido por las llamadas concurrentes. @type {Promise|null} */
  #connecting;

  #debug(msg) {
    if (this.onDebug) this.onDebug(msg);
  }

  #headers() {
    const h = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      // El servidor puede contestar cualquiera de los dos; pedimos ambos.
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }

  #captureRateLimit(res) {
    const remaining = res.headers.get("ratelimit-remaining");
    if (remaining === null) return;
    this.rateLimit = {
      limit: res.headers.get("ratelimit-limit"),
      remaining,
      reset: res.headers.get("ratelimit-reset"),
      policy: res.headers.get("ratelimit-policy"),
    };
    this.#debug(`ratelimit: ${remaining}/${this.rateLimit.limit} restantes, reset en ${this.rateLimit.reset}s`);
  }

  /** POST crudo al endpoint. Devuelve { res, text }. */
  async #post(body) {
    let res;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err?.name === "TimeoutError" ? `timeout tras ${this.timeoutMs} ms` : err?.message || String(err);
      throw new McpTransportError(`No se pudo contactar ${this.url}: ${reason}`);
    }
    this.#captureRateLimit(res);
    const text = await res.text();
    return { res, text };
  }

  /**
   * Traduce las respuestas de error a algo accionable, o devuelve null si no
   * es un error. Ojo: 401/402/403/429 NO son sobres JSON-RPC — los emite la
   * capa Express de la celda, con `{error, message|error_description}`.
   */
  #httpError(res, text, method) {
    if (res.ok) return null;
    const detail = describeErrorBody(text);
    const opts = { status: res.status, body: text, wwwAuthenticate: res.headers.get("www-authenticate") };

    if (res.status === 401) {
      return new McpTransportError(`Token rechazado (401). ${detail}`, opts);
    }
    if (res.status === 403) {
      return new McpTransportError(
        `Acceso denegado (403): al token le faltan scopes para MCP. ${detail}\n` +
          `  Se necesita al menos uno de: rag.query, kb.read, agent.verify, agent.write_audit.`,
        opts,
      );
    }
    if (res.status === 402) {
      return new McpTransportError(
        `El plan del workspace no incluye el módulo agentic_api (402). ${detail}`,
        opts,
      );
    }
    if (res.status === 429 && /active sessions/i.test(text)) {
      // Tope de 5 sesiones concurrentes por credencial. No trae Retry-After:
      // esperar no sirve, hay que cerrar sesiones (o esperar el TTL de 30 min).
      return new McpTransportError(
        `Tope de sesiones MCP concurrentes alcanzado (429). ${detail}\n` +
          `  Son 5 por credencial y expiran a los 30 min de inactividad. Esperar no ayuda: ` +
          `cerrá las sesiones abiertas (el CLI hace DELETE al terminar, pero un proceso matado a mano las deja colgadas).`,
        opts,
      );
    }
    if (res.status === 502 || res.status === 504) {
      return new McpTransportError(`El gateway no pudo hablar con la celda (${res.status}). ${detail}`, opts);
    }
    return new McpTransportError(`HTTP ${res.status} en ${method}. ${detail}`, opts);
  }

  /**
   * POST con reintento único ante rate limit reintentable. Lo usan por igual
   * `#rpc`, `connect` y `#notify`: el presupuesto de 60/min cuenta TODAS las
   * POST, `initialize` incluida, así que el handshake también puede comerse un
   * 429 y tiene que reintentar como cualquier otra llamada.
   */
  async #postWithRetry(body, label, { allowRetry = true } = {}) {
    const { res, text } = await this.#post(body);

    // 429 de presupuesto y 503 del limiter caído sí valen un reintento; el 429
    // por tope de sesiones no (esperar no libera nada; lo traduce #httpError).
    const retryable =
      (res.status === 429 && !/active sessions/i.test(text)) || (res.status === 503 && /RATE_LIMITER_UNAVAILABLE/i.test(text));
    if (!retryable) return { res, text };

    if (!allowRetry) {
      throw new McpTransportError(`Rate limit persistente (HTTP ${res.status}) tras reintentar`, { status: res.status, body: text });
    }
    const waitS = Math.min(Number(res.headers.get("retry-after")) || Number(res.headers.get("ratelimit-reset")) || 5, 60);
    this.#debug(`HTTP ${res.status}: esperando ${waitS}s antes de reintentar ${label}`);
    await new Promise((r) => setTimeout(r, waitS * 1000));
    return this.#postWithRetry(body, label, { allowRetry: false });
  }

  /**
   * Ejecuta un método JSON-RPC, con reintento ante rate limit y re-handshake
   * ante sesión perdida (400 "Server not initialized" / 404 -32001).
   */
  async #rpc(method, params, { allowRecovery = true } = {}) {
    const id = this._nextId++;
    const body = { jsonrpc: "2.0", method, id };
    if (params !== undefined) body.params = params;

    const { res, text } = await this.#postWithRetry(body, method);

    // Sesión caída o expirada. Pasa de verdad: `activeSessions` es un Map local
    // al proceso, así que en una celda con varias réplicas el session id solo
    // vale en la réplica que lo creó.
    const sessionLost = res.status === 404 || (res.status === 400 && /not initialized|session/i.test(text));
    if (sessionLost && allowRecovery && method !== "initialize") {
      // Si el 400/404 vino del ruteo multi-réplica y no de una expiración, la
      // sesión vieja SIGUE viva en la réplica que la creó. Olvidar su id la
      // dejaría colgada 30 min ocupando uno de los 5 cupos, así que la
      // conservamos para intentar cerrarla en close().
      this.#debug(`sesión perdida (HTTP ${res.status}): re-inicializando (la anterior queda para cerrar)`);
      this.sessionId = null;
      await this.connect();
      return this.#rpc(method, params, { allowRecovery: false });
    }

    const httpErr = this.#httpError(res, text, method);
    if (httpErr) throw httpErr;

    const contentType = res.headers.get("content-type") || "";
    let frame;
    if (contentType.includes("text/event-stream")) {
      frame = parseSseFrames(text, id);
    } else {
      try {
        frame = JSON.parse(text);
      } catch {
        throw new McpTransportError(`Respuesta ilegible en ${method}`, { status: res.status, body: text });
      }
    }
    if (!frame) {
      throw new McpTransportError(`El servidor no devolvió respuesta para ${method}`, { status: res.status, body: text });
    }
    if (frame.error) {
      throw new McpTransportError(`JSON-RPC ${frame.error.code}: ${frame.error.message}`, {
        status: res.status,
        body: text,
      });
    }
    return { result: frame.result, envelope: frame, res };
  }

  /** Notificación (sin `id`): el servidor responde 202 sin cuerpo. */
  async #notify(method, params) {
    const body = { jsonrpc: "2.0", method };
    if (params !== undefined) body.params = params;
    const { res, text } = await this.#postWithRetry(body, method);
    if (res.ok || res.status === 202) return;

    // Una notificación que cae en una réplica que no conoce la sesión da el
    // mismo 400/404 que un RPC. No es fatal: el SDK no gatea `tools/call` en
    // `notifications/initialized`, y el re-handshake de #rpc cubre el resto.
    if (res.status === 404 || (res.status === 400 && /not initialized|session/i.test(text))) {
      this.#debug(`la notificación ${method} no encontró la sesión (HTTP ${res.status}); sigo igual`);
      return;
    }
    throw new McpTransportError(`HTTP ${res.status} en la notificación ${method}`, { status: res.status, body: text });
  }

  /**
   * Handshake completo. Idempotente y **seguro ante concurrencia**: varias
   * llamadas en paralelo comparten un único handshake.
   *
   * Sin esto, un `Promise.all([client.call(…), client.call(…)])` hacía que
   * todos vieran `sessionId === null` y arrancaran su propio `initialize`:
   * quemaban varios de los 5 cupos por credencial y se pisaban el `sessionId`.
   */
  async connect() {
    if (this.sessionId) return this;
    if (this.#connecting) return this.#connecting;

    this.#connecting = this.#handshake().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #handshake() {
    const id = this._nextId++;
    const { res, text } = await this.#postWithRetry(
      {
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
        id,
      },
      "initialize",
    );

    const httpErr = this.#httpError(res, text, "initialize");
    if (httpErr) throw httpErr;

    const sid = res.headers.get("mcp-session-id");
    if (!sid) {
      throw new McpTransportError("El servidor no devolvió la cabecera Mcp-Session-Id en initialize", {
        status: res.status,
        body: text,
      });
    }
    this.sessionId = sid;
    this.#knownSessions.add(sid);

    const contentType = res.headers.get("content-type") || "";
    const frame = contentType.includes("text/event-stream") ? parseSseFrames(text, id) : safeJson(text);
    this.serverInfo = frame?.result?.serverInfo ?? null;
    this.#debug(
      `sesión ${sid} · servidor ${this.serverInfo?.name ?? "?"} ${this.serverInfo?.version ?? ""} · protocolo ${
        frame?.result?.protocolVersion ?? "?"
      }`,
    );

    await this.#notify("notifications/initialized");
    return this;
  }

  /**
   * Lista las herramientas que el servidor declara de verdad.
   * @returns {{ tools: object[], envelope: object }} — devuelve el sobre igual
   *   que `call()`, para que `--raw` también sirva con `tools/list`.
   */
  async listTools() {
    await this.connect();
    const { result, envelope } = await this.#rpc("tools/list");
    return { tools: result?.tools ?? [], envelope };
  }

  /**
   * Invoca una herramienta.
   * @returns {{ data: any, text: string, envelope: object }}
   *   `data` = el payload ya des-anidado (JSON.parse del texto, o el texto crudo
   *   si no es JSON). `envelope` = el sobre JSON-RPC completo, para --raw.
   */
  async call(name, args = {}) {
    await this.connect();
    const { result, envelope } = await this.#rpc("tools/call", { name, arguments: args });

    const text = (result?.content ?? [])
      .filter((c) => c?.type === "text")
      .map((c) => c.text)
      .join("\n");

    if (result?.isError) {
      throw new McpToolError(text || `La herramienta ${name} falló sin detalle`, {
        tool: name,
        content: result.content,
        envelope,
      });
    }
    return { data: safeJson(text) ?? text, text, envelope };
  }

  /**
   * Cierra TODAS las sesiones que abrió este cliente, no solo la vigente: un
   * re-handshake por ruteo multi-réplica deja viva la anterior, y cada una
   * ocupa uno de los 5 cupos por credencial durante 30 minutos.
   *
   * Best-effort: nunca lanza. Pero sí verifica el resultado — `fetch` resuelve
   * normal ante 400/404, así que un `try/catch` solo no distingue el borrado
   * real del fallido. Lo que no se pudo cerrar se reporta por `--verbose`.
   */
  async close() {
    if (this.sessionId) this.#knownSessions.add(this.sessionId);
    const pending = [...this.#knownSessions];
    this.sessionId = null;
    this.#connecting = null;
    if (pending.length === 0) return;

    for (const sid of pending) {
      // Un 400/404 acá suele ser ruteo: el DELETE cayó en una réplica que no
      // es la dueña, y la sesión sigue viva. Cloud Run reparte entre
      // instancias, así que reintentar tiene chance real de pegarle a la
      // correcta. Lo que aun así no cierre se CONSERVA en #knownSessions: un
      // segundo close() lo vuelve a intentar en vez de perderlo para siempre.
      let ok = false;
      for (let intento = 1; intento <= DELETE_ATTEMPTS && !ok; intento++) {
        try {
          const res = await fetch(this.url, {
            method: "DELETE",
            headers: { ...this.#headers(), "Mcp-Session-Id": sid },
            signal: AbortSignal.timeout(10_000),
          });
          ok = res.status === 204 || res.ok;
          if (!ok) this.#debug(`DELETE de ${sid} devolvió HTTP ${res.status} (intento ${intento}/${DELETE_ATTEMPTS})`);
        } catch (err) {
          this.#debug(`DELETE de ${sid} falló: ${err?.message ?? err} (intento ${intento}/${DELETE_ATTEMPTS})`);
        }
      }
      if (ok) this.#knownSessions.delete(sid);
    }

    if (this.#knownSessions.size) {
      this.#debug(
        `quedaron ${this.#knownSessions.size} sesión(es) sin cerrar (${[...this.#knownSessions].join(", ")}). ` +
          `Ocupan cupo hasta expirar (30 min); se liberan con DELETE ${this.url} + Mcp-Session-Id, ` +
          `o llamando a close() de nuevo.`,
      );
    }
  }
}

function safeJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Saca un mensaje legible de un cuerpo de error, sea JSON-RPC o de Express. */
function describeErrorBody(text) {
  const body = safeJson(text);
  if (!body) return String(text ?? "").slice(0, 300);
  const msg = body.error?.message ?? body.message ?? body.error_description ?? (typeof body.error === "string" ? body.error : null);
  return msg ? String(msg) : String(text).slice(0, 300);
}
