/**
 * Plomería HTTP compartida por los dos clientes (`mcp-client.mjs`,
 * `api-client.mjs`), el bucle (`loop.mjs`) y la sincronización de la colección
 * (`collection-sync.mjs`).
 *
 * Existe porque las cuatro copias ya habían divergido: `api-client` corrigió el
 * idioma `Number(h) || default` de la espera ante 429 (un `Retry-After: 0`
 * caía en el default y esperaba cinco segundos de más) y `mcp-client` lo
 * conservó; `mcp-client` leía `body.error.message` y `api-client` no, así que
 * el mismo cuerpo de error se imprimía legible por un carril y como JSON crudo
 * por el otro; y ninguna de las cuatro decía POR QUÉ falló un `fetch`. Cada
 * arreglo había que hacerlo cuatro veces y se hacía una.
 */

/** `JSON.parse` que devuelve `null` en vez de lanzar. */
export function safeJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Saca un mensaje legible de un cuerpo de error, sea JSON-RPC
 * (`{error: {message}}`) o de Express (`{error, message | error_description}`).
 */
export function describeErrorBody(text) {
  const body = safeJson(text);
  if (!body || typeof body !== "object") return String(text ?? "").slice(0, 300);
  const msg =
    body.error?.message ?? body.message ?? body.error_description ?? (typeof body.error === "string" ? body.error : null);
  return msg ? String(msg) : String(text).slice(0, 300);
}

/**
 * Cuántos segundos pide esperar el servidor, o `null` si no lo dice.
 *
 * Devuelve `null` y no `0` para "no dijo nada", porque **cero es una respuesta
 * válida**: significa reintentá ya. Con el idioma `Number(h) || default`, un
 * `Retry-After: 0` caía en el default y hacía esperar cinco segundos de más —
 * exactamente al revés de lo que el servidor pidió.
 */
export function esperaSugerida(res) {
  for (const h of ["retry-after", "x-ratelimit-reset", "ratelimit-reset"]) {
    const raw = res.headers.get(h);
    if (raw === null) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/**
 * Por qué falló un `fetch`, en una línea que distingue DNS de puerto cerrado.
 *
 * Node envuelve la causa real en `err.cause` (`ENOTFOUND`, `ECONNREFUSED`,
 * `CERT_HAS_EXPIRED`…) y deja en `err.message` un `fetch failed` genérico. Sin
 * mirar la causa, un host mal tipeado y un servidor apagado se ven igual.
 */
export function describirFalloFetch(err, timeoutMs) {
  if (err?.name === "TimeoutError") return `timeout tras ${timeoutMs} ms`;
  const base = err?.message || String(err);
  const causa = err?.cause;
  const codigo = causa?.code ?? null;
  const mensaje = causa?.message && causa.message !== base ? causa.message : null;
  if (!codigo && !mensaje) return base;
  if (!codigo) return `${base} (${mensaje})`;
  return `${base} (${codigo}${mensaje ? `: ${mensaje}` : ""})`;
}

/**
 * El presupuesto de rate limit que trae una respuesta, o `null` si no trae.
 *
 * Se leen las dos grafías porque conviven: la REST manda `X-RateLimit-*` y el
 * borde MCP manda `ratelimit-*`. `get()` es case-insensitive, así que lo único
 * que hace falta es probar ambas.
 */
export function leerRateLimit(res) {
  const remaining = res.headers.get("x-ratelimit-remaining") ?? res.headers.get("ratelimit-remaining");
  if (remaining === null) return null;
  return {
    limit: res.headers.get("x-ratelimit-limit") ?? res.headers.get("ratelimit-limit"),
    remaining,
    reset: res.headers.get("x-ratelimit-reset") ?? res.headers.get("ratelimit-reset"),
    policy: res.headers.get("ratelimit-policy"),
    retryAfter: res.headers.get("retry-after"),
  };
}
