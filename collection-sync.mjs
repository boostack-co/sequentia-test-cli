/**
 * `api collection --check` — ¿lo publicado es lo que revisamos?
 *
 * Es el **control de gobierno** de la colección, no un chequeo de higiene. El
 * original vive en este repo y lo de Postman es una copia; la regla es que
 * nadie edita en la interfaz de Postman. Esto es lo único que distingue «la
 * colección está publicada» de «lo publicado es lo que pasó por un PR», y por
 * eso es lo que hace segura esa regla: si alguien edita allá, esto lo caza y se
 * repone desde acá, nunca al revés.
 *
 * Si la URL de lectura se revoca, lo único que se rompe es este comando: el CLI
 * sigue andando con la colección empaquetada. Es a propósito, y es la razón de
 * que el original viva en el repo.
 *
 * **La comparación es del catálogo, no del JSON crudo.** Postman le agrega
 * `_postman_id`, `uid`, `owner` y marcas de tiempo a lo que publica, así que un
 * diff textual estaría siempre en rojo y dejaría de leerse — que es la forma
 * más común de que un control deje de controlar. Se comparan las cosas de las
 * que alguien depende: método, ruta, cuerpo, y la metadata que gobierna la
 * guarda de `--yes`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { USER_ENV_FILE } from "./commands.mjs";
import { catalogoDesde } from "./catalog.mjs";
import { describirFalloFetch } from "./http-comun.mjs";

/** Dónde queda la copia de lo último que se trajo. */
export const CACHE_FILE = join(dirname(USER_ENV_FILE), "coleccion-publicada.json");

/** Los campos de los que alguien depende. El resto es ruido de Postman. */
// `query` estaba afuera, y era un agujero: los parámetros no forman parte de
// `ruta` —que es solo el path—, así que cambiar, agregar o desactivar uno en
// Postman dejaba el chequeo en verde. Es justo lo que gobierna qué devuelve una
// petición (`?q=`, `?limit=`), o sea lo que un cliente nota primero.
const COMPARABLES = ["metodo", "ruta", "query", "scopes", "persists", "spendsCredits", "internalRead", "captures", "auth", "body", "cabeceras"];

export class SyncError extends Error {}

/**
 * Trae la colección publicada.
 *
 * La URL lleva su access key: es de solo lectura y de una sola colección, así
 * que es publicable — a diferencia de la API key de Postman de quien publica,
 * que no entra al repo y que el job `secretos` del CI rechazaría.
 */
export async function traerPublicada(url, { timeoutMs = 20000 } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new SyncError(`No se pudo traer la colección publicada: ${describirFalloFetch(err, timeoutMs)}`);
  }
  const texto = await res.text();
  if (!res.ok) {
    const pista =
      res.status === 401 || res.status === 403
        ? "\n  La access key puede haber sido rotada o revocada. Mirá collection/PUBLISHING.md."
        : "";
    throw new SyncError(`La colección publicada respondió ${res.status}.${pista}`);
  }
  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    throw new SyncError(
      `La colección publicada no devolvió JSON.\n  Recibí: ${texto.slice(0, 200)}\n` +
        `  Revisá que la URL sea la de la API de Postman y no la de la página web.`,
    );
  }
  // La API de Postman envuelve en { collection: … }; un export a mano no.
  return json.collection ?? json;
}

/** Compara dos catálogos y devuelve las diferencias, **en los dos sentidos**. */
export function comparar(local, remoto) {
  const derivas = [];
  const nombresLocal = new Set(local.entradas.keys());
  const nombresRemoto = new Set(remoto.entradas.keys());

  for (const nombre of nombresLocal) {
    if (!nombresRemoto.has(nombre)) derivas.push({ tipo: "solo-en-el-repo", nombre });
  }
  for (const nombre of nombresRemoto) {
    if (!nombresLocal.has(nombre)) derivas.push({ tipo: "solo-en-postman", nombre });
  }

  for (const nombre of nombresLocal) {
    if (!nombresRemoto.has(nombre)) continue;
    const a = local.entradas.get(nombre);
    const b = remoto.entradas.get(nombre);
    for (const campo of COMPARABLES) {
      const va = JSON.stringify(a[campo] ?? null);
      const vb = JSON.stringify(b[campo] ?? null);
      if (va !== vb) derivas.push({ tipo: "difiere", nombre, campo, repo: va, postman: vb });
    }
    // La descripción es documentación de cara al cliente: si difiere, es deriva
    // igual. No se vuelca entera porque son párrafos y taparía el resto.
    if (a.descripcion !== b.descripcion) derivas.push({ tipo: "descripcion", nombre });
  }

  // Las variables de ámbito de colección gobiernan el encadenado de Postman;
  // una que falte allá rompe `Get article` sin que ninguna petición cambie.
  const varsA = (local.coleccion.variable ?? []).map((v) => v.key).sort();
  const varsB = (remoto.coleccion.variable ?? []).map((v) => v.key).sort();
  if (JSON.stringify(varsA) !== JSON.stringify(varsB)) {
    derivas.push({ tipo: "variables", repo: varsA.join(", "), postman: varsB.join(", ") });
  }
  return derivas;
}

/** Guarda lo traído, para poder mirarlo sin volver a salir a la red. */
export function guardarCache(coleccion) {
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(coleccion, null, 2) + "\n", "utf8");
  return CACHE_FILE;
}

/**
 * El catálogo de una colección ya parseada. Valida al armarlo, así que va
 * ANTES de `guardarCache`: lo que se guarda es lo que se pudo cargar, y una
 * colección remota rota no queda en la caché con el comando fallando.
 */
export function catalogoDe(coleccion) {
  return catalogoDesde(coleccion);
}

/** El informe en texto. */
export function formatearDerivas(derivas) {
  if (!derivas.length) {
    return ["✔ Sin deriva: lo publicado es lo que está en el repo."];
  }
  const L = [`✘ ${derivas.length} deriva(s) entre el repo y lo publicado en Postman:`, ""];
  for (const d of derivas) {
    if (d.tipo === "solo-en-el-repo") L.push(`  · "${d.nombre}" está en el repo y NO publicada — falta republicar`);
    else if (d.tipo === "solo-en-postman") L.push(`  · "${d.nombre}" está publicada y NO en el repo — alguien editó en la UI de Postman`);
    else if (d.tipo === "descripcion") L.push(`  · "${d.nombre}": la descripción difiere`);
    else if (d.tipo === "variables") L.push(`  · variables de colección: repo [${d.repo}] vs Postman [${d.postman}]`);
    else L.push(`  · "${d.nombre}" · ${d.campo}:\n      repo:    ${d.repo}\n      Postman: ${d.postman}`);
  }
  L.push("");
  L.push("El repo es el original y Postman la copia: se repone republicando desde acá,");
  L.push("nunca copiando de Postman al repo. Ver collection/PUBLISHING.md.");
  return L;
}
