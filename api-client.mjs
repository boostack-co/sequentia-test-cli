/**
 * Cliente REST (`/api/v1`) para el servidor de Sequentia.
 *
 * Sin dependencias: usa `fetch` y `AbortSignal` nativos de Node >= 18.
 *
 * Es el hermano de `mcp-client.mjs` y tiene su mismo temperamento —traduce los
 * errores a algo accionable en vez de escupir el status— pero el transporte no
 * se parece en nada:
 *
 *  1. NO es stateful. No hay handshake, ni sesión, ni cupo de sesiones
 *     concurrentes: cada petición se vale por sí misma.
 *  2. Responde JSON, no SSE. El payload NO viene doblemente serializado.
 *  3. Los errores SÍ son el status HTTP. Al revés que en MCP, donde un fallo de
 *     herramienta viaja dentro de un 200 como `isError`.
 *  4. Es OTRO HOST. El endpoint MCP suele ser el gateway universal; éste es el
 *     origen directo de la celda. Suponer que son el mismo da 404.
 *
 * Lo que sí comparte: el reintento único ante rate limit, y que un mensaje de
 * error tiene que decir qué hacer.
 */

/** El prefijo que llevan todas las rutas. Se agrega acá, una sola vez. */
export const API_PREFIX = "/api/v1";

/** Falla del transporte, de autenticación, de plan o de rate limit. */
export class ApiTransportError extends Error {
  constructor(message, { status = null, body = null, code = null, wwwAuthenticate = null } = {}) {
    super(message);
    this.name = "ApiTransportError";
    this.status = status;
    this.body = body;
    /** El `code` del cuerpo cuando lo trae (`MODULE_NOT_ENTITLED`, `RATE_LIMITED`, …). */
    this.code = code;
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

/**
 * Normaliza el origen de la celda. Acepta la URL **con y sin** `/api/v1`.
 *
 * No es una comodidad: cada ruta de este cliente ya empieza con `/api/v1`, así
 * que pegar el base URL en la forma en que suele aparecer documentado producía
 * `/api/v1/api/v1/health` — un 404 que se lee como un problema del despliegue
 * y es de configuración.
 *
 * @throws {ApiTransportError} si no es una URL http(s) parseable.
 */
export function normalizeApiBase(raw) {
  const s = String(raw ?? "").trim();
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new ApiTransportError(`"${s}" no es una URL válida (esperaba algo como https://celda.example)`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new ApiTransportError(`"${s}" no es http(s)`);
  }
  // Se conserva el path por si la celda vive detrás de un prefijo, pero se le
  // quita el `/api/v1` final, que es el que duplicaría.
  let path = u.pathname.replace(/\/+$/, "");
  if (path.toLowerCase().endsWith(API_PREFIX)) path = path.slice(0, -API_PREFIX.length);
  return `${u.origin}${path}`;
}

export class SequentiaApiClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl   origen directo de la celda, con o sin `/api/v1`
   * @param {string} [opts.token]   API key `sk_live_…`. Opcional: `/health` no la pide
   * @param {number} [opts.timeoutMs]
   * @param {(msg: string) => void} [opts.onDebug] traza a stderr (--verbose)
   */
  constructor({ baseUrl, token = null, timeoutMs = 120_000, onDebug = null }) {
    if (!baseUrl) throw new ApiTransportError("Falta la URL de la celda");
    this.baseUrl = normalizeApiBase(baseUrl);
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.onDebug = onDebug;
    this.rateLimit = null;
  }

  #debug(msg) {
    if (this.onDebug) this.onDebug(msg);
  }

  /**
   * El presupuesto de rate limit. Se leen las dos grafías porque conviven: la
   * REST manda `X-RateLimit-*` y el borde MCP manda `ratelimit-*`. `get()` es
   * case-insensitive, así que lo único que hace falta es probar ambas.
   */
  #captureRateLimit(res) {
    const remaining = res.headers.get("x-ratelimit-remaining") ?? res.headers.get("ratelimit-remaining");
    if (remaining === null) return;
    this.rateLimit = {
      limit: res.headers.get("x-ratelimit-limit") ?? res.headers.get("ratelimit-limit"),
      remaining,
      reset: res.headers.get("x-ratelimit-reset") ?? res.headers.get("ratelimit-reset"),
      retryAfter: res.headers.get("retry-after"),
    };
    this.#debug(`ratelimit: ${remaining}/${this.rateLimit.limit} restantes, reset ${this.rateLimit.reset}`);
  }

  #headers({ auth, hasBody }) {
    const h = { Accept: "application/json" };
    if (hasBody) h["Content-Type"] = "application/json";
    if (auth) {
      if (!this.token) {
        throw new ApiTransportError("Esta petición necesita una API key y no hay ninguna configurada");
      }
      h.Authorization = `Bearer ${this.token}`;
    }
    return h;
  }

  /** Un intento crudo. Devuelve { res, text }. */
  async #send(url, { method, headers, body }) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err?.name === "TimeoutError" ? `timeout tras ${this.timeoutMs} ms` : err?.message || String(err);
      throw new ApiTransportError(
        `No se pudo contactar ${url}: ${reason}\n` +
          `  Si el host no resuelve, el problema es la URL de la celda y no la credencial.`,
      );
    }
    this.#captureRateLimit(res);
    return { res, text: await res.text() };
  }

  /**
   * Una petición, con reintento único ante rate limit reintentable.
   *
   * Se reintenta el 429 de presupuesto y el 503 del limiter caído, igual que en
   * el cliente MCP. Nada más: reintentar un 402 o un 403 no cambia el resultado
   * y gasta cuota.
   *
   * @returns {{ status: number, data: any, text: string, res: Response }}
   */
  async request(method, path, { body, auth = true, headers: extra } = {}) {
    const url = `${this.baseUrl}${API_PREFIX}${path}`;
    const headers = { ...this.#headers({ auth, hasBody: body !== undefined }), ...extra };
    this.#debug(`${method} ${url}`);

    let { res, text } = await this.#send(url, { method, headers, body });

    const retryable =
      res.status === 429 || (res.status === 503 && /RATE_LIMITER_UNAVAILABLE/i.test(text));
    if (retryable) {
      const waitS = Math.min(esperaSugerida(res) ?? 5, 60);
      this.#debug(`HTTP ${res.status}: esperando ${waitS}s antes de reintentar ${method} ${path}`);
      await new Promise((r) => setTimeout(r, waitS * 1000));
      ({ res, text } = await this.#send(url, { method, headers, body }));
    }

    const err = this.#httpError(res, text, `${method} ${path}`);
    if (err) throw err;

    const data = safeJson(text);
    if (data === null && text.trim() !== "") {
      // 2xx que no es JSON. El caso típico es haber apuntado a un host que
      // existe pero no es la celda: un proxy, una landing, un balanceador. Un
      // cliente que devolviera el texto crudo dejaría que el error apareciera
      // mucho después, disfrazado de "el servidor no trae el campo X".
      throw new ApiTransportError(
        `${url} respondió ${res.status} pero el cuerpo no es JSON.\n` +
          `  Suele significar que la URL no es la de la celda (un proxy o una landing contestando por ella).\n` +
          `  Recibí: ${text.slice(0, 200)}`,
        { status: res.status, body: text },
      );
    }
    return { status: res.status, data, text, res };
  }

  /**
   * `GET /api/v1/health` — la única petición **sin autenticar**.
   *
   * Es el primer diagnóstico a propósito: si falla acá, el problema es la URL y
   * no la credencial. Cualquier otro orden hace que un token malo y un host mal
   * copiado se vean igual.
   */
  async health() {
    return this.request("GET", "/health", { auth: false });
  }

  /**
   * Traduce las respuestas de error a algo accionable, o devuelve null si no lo
   * es. Lo que hace falta distinguir acá no son los status —esos los da el
   * servidor— sino las causas DISTINTAS que comparten un mismo status: mandar a
   * alguien a rotar una key que estaba bien cuesta más que el error original.
   */
  #httpError(res, text, label) {
    if (res.ok) return null;
    const body = safeJson(text);
    const detail = describeErrorBody(text);
    const code = body?.code ?? null;
    const opts = { status: res.status, body: text, code, wwwAuthenticate: res.headers.get("www-authenticate") };

    if (res.status === 401) {
      return new ApiTransportError(
        `Token rechazado (401). ${detail}\n` +
          `  Una key válida empieza con "sk_live_"; las de la extensión de navegador no sirven acá.`,
        opts,
      );
    }

    if (res.status === 402) {
      // Tres cosas distintas con el mismo status, y el remedio de cada una es
      // otro: cambiar de plan, cargar créditos, o hablar con administración.
      if (code === "MODULE_NOT_ENTITLED" || /module/i.test(detail)) {
        return new ApiTransportError(
          `El plan del workspace no incluye el módulo agéntico (402). ${detail}\n` +
            `  Es cuestión de plan, no de scopes: ninguna key lo abre.`,
          opts,
        );
      }
      if (/credit/i.test(detail)) {
        return new ApiTransportError(
          `Sin créditos de IA (402). ${detail}\n` +
            `  La credencial y el plan están bien; lo que falta es saldo.`,
          opts,
        );
      }
      return new ApiTransportError(
        `El workspace no está operativo (402). ${detail}\n` + `  La key es válida: lo que está cerrado es el workspace.`,
        opts,
      );
    }

    if (res.status === 403) {
      if (/knowledge base/i.test(detail)) {
        return new ApiTransportError(
          `La key no tiene acceso a esa knowledge base (403). ${detail}\n` +
            `  No es un scope faltante: es la lista blanca de KBs de la credencial.`,
          opts,
        );
      }
      return new ApiTransportError(
        `Acceso denegado (403). ${detail}\n` +
          `  Si el mensaje nombra un scope, la key no lo tiene. Ojo: los formularios de Admin Studio ` +
          `no son superconjunto entre sí, y hay scopes que no se conceden desde la UI.`,
        opts,
      );
    }

    if (res.status === 404) {
      // Deliberado del servidor: una KB inexistente y una de otro workspace
      // contestan igual, para no revelar cuáles existen. Decirlo evita que
      // alguien se pase la tarde buscando un id que sí era correcto.
      return new ApiTransportError(
        `No encontrado (404). ${detail}\n` +
          `  Si es una knowledge base: el servidor responde lo mismo cuando no existe y cuando es de otro workspace.`,
        opts,
      );
    }

    if (res.status === 409) {
      return new ApiTransportError(
        `Conflicto de idempotencia (409). ${detail}\n` +
          `  La misma clave de idempotencia se usó antes con un cuerpo distinto; la ventana es de 24 h.`,
        opts,
      );
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      return new ApiTransportError(
        `Rate limit (429)${retryAfter ? `, reintentar en ${retryAfter}s` : ""}. ${detail}\n` +
          `  Hay dos techos con relojes distintos: el de la credencial y uno por IP en el borde.`,
        opts,
      );
    }

    if (res.status === 503 && /RATE_LIMITER_UNAVAILABLE/i.test(text)) {
      return new ApiTransportError(
        `El limitador de tasa no está disponible y falla cerrado (503). ${detail}\n` +
          `  No te limitaron: el servidor prefiere rechazar antes que dejar pasar sin contar.`,
        opts,
      );
    }

    if (res.status === 502 || res.status === 504) {
      return new ApiTransportError(`El gateway no pudo hablar con la celda (${res.status}). ${detail}`, opts);
    }

    return new ApiTransportError(`HTTP ${res.status} en ${label}. ${detail}`, opts);
  }
}

/**
 * Cuántos segundos pide esperar el servidor, o `null` si no lo dice.
 *
 * Devuelve `null` y no `0` para "no dijo nada", porque **cero es una respuesta
 * válida**: significa reintentá ya. Con el idioma `Number(h) || default`, un
 * `Retry-After: 0` caía en el default y hacía esperar cinco segundos de más —
 * exactamente al revés de lo que el servidor pidió.
 */
function esperaSugerida(res) {
  for (const h of ["retry-after", "x-ratelimit-reset", "ratelimit-reset"]) {
    const raw = res.headers.get(h);
    if (raw === null) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function safeJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Saca un mensaje legible del cuerpo de error, que la celda emite como `{error, message}`. */
function describeErrorBody(text) {
  const body = safeJson(text);
  if (!body) return String(text ?? "").slice(0, 300);
  const msg = body.message ?? body.error_description ?? (typeof body.error === "string" ? body.error : null);
  return msg ? String(msg) : String(text).slice(0, 300);
}
