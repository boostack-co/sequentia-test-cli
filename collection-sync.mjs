/**
 * `api collection --check` — ¿la copia que empaquetamos es la que sirve la celda?
 *
 * Es el **control de gobierno** de la colección, no un chequeo de higiene, y
 * desde el vendorado apunta al revés que antes: el original lo genera la
 * plataforma desde sus routers y cada celda lo sirve en `/.well-known/`, así
 * que lo de esta carpeta es una copia. Esto es lo único que distingue «hay una
 * colección en el repo» de «la que hay es la que la celda está sirviendo», y
 * por eso es lo que hace cumplir la regla de no editar la carpeta a mano: si
 * alguien lo hace, esto lo caza y se repone re-vendorando, nunca al revés.
 *
 * Si la celda no responde, lo único que se rompe es este comando: el CLI sigue
 * andando con la colección empaquetada. Es a propósito, y es la razón de que la
 * copia siga viviendo en el repo.
 *
 * **La comparación es del catálogo, no del JSON crudo.** Un export de Postman
 * agrega `_postman_id`, `uid`, `owner` y marcas de tiempo, así que un diff
 * textual estaría siempre en rojo y dejaría de leerse — que es la forma más
 * común de que un control deje de controlar. Se comparan las cosas de las que
 * alguien depende: método, ruta, cuerpo, y la metadata que gobierna la guarda
 * de `--yes`.
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
 * Trae la colección que sirve la celda.
 *
 * La ruta es pública y no lleva credencial: la atiende el mismo build que
 * atiende la API. Antes era una URL de Postman con su access key colgando, que
 * es justo la clase de cadena que el job `secretos` del CI rechaza.
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
        ? "\n  Esa ruta es pública y no lleva credencial, así que un 401/403 NO es tu key.\n" +
          "  O la celda todavía no sirve su colección, o el origen que configuraste no es una celda.\n" +
          "  Ver collection/PUBLISHING.md."
        : "";
    throw new SyncError(`La colección publicada respondió ${res.status}.${pista}`);
  }
  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    throw new SyncError(
      `La colección de la celda no devolvió JSON.\n  Recibí: ${texto.slice(0, 200)}\n` +
        `  Revisá que el origen sea el de una celda y la ruta /.well-known/postman-collection.json.`,
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
    if (!nombresLocal.has(nombre)) derivas.push({ tipo: "solo-en-la-celda", nombre });
  }

  for (const nombre of nombresLocal) {
    if (!nombresRemoto.has(nombre)) continue;
    const a = local.entradas.get(nombre);
    const b = remoto.entradas.get(nombre);
    for (const campo of COMPARABLES) {
      const va = JSON.stringify(a[campo] ?? null);
      const vb = JSON.stringify(b[campo] ?? null);
      if (va !== vb) derivas.push({ tipo: "difiere", nombre, campo, repo: va, celda: vb });
    }
    // La descripción es documentación de cara al cliente: si difiere, es deriva
    // igual. No se vuelca entera porque son párrafos y taparía el resto.
    if (a.descripcion !== b.descripcion) derivas.push({ tipo: "descripcion", nombre });
  }

  // Las variables de ámbito de colección gobiernan el encadenado de Postman;
  // una que falte rompe `Get article` sin que ninguna petición cambie.
  const varsA = (local.coleccion.variable ?? []).map((v) => v.key).sort();
  const varsB = (remoto.coleccion.variable ?? []).map((v) => v.key).sort();
  if (JSON.stringify(varsA) !== JSON.stringify(varsB)) {
    derivas.push({ tipo: "variables", repo: varsA.join(", "), celda: varsB.join(", ") });
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
    return ["✔ Sin deriva: la copia del repo es la que sirve la celda."];
  }
  const L = [`✘ ${derivas.length} deriva(s) entre la copia del repo y lo que sirve la celda:`, ""];
  for (const d of derivas) {
    if (d.tipo === "solo-en-el-repo")
      L.push(`  · "${d.nombre}" está en el repo y la celda NO la sirve — o se editó la carpeta a mano, o la copia es de un build viejo`);
    else if (d.tipo === "solo-en-la-celda") L.push(`  · "${d.nombre}" la sirve la celda y NO está en el repo — falta re-vendorar`);
    else if (d.tipo === "descripcion") L.push(`  · "${d.nombre}": la descripción difiere`);
    else if (d.tipo === "variables") L.push(`  · variables de colección: repo [${d.repo}] vs celda [${d.celda}]`);
    else L.push(`  · "${d.nombre}" · ${d.campo}:\n      repo:  ${d.repo}\n      celda: ${d.celda}`);
  }
  L.push("");
  L.push("El original lo genera la plataforma y la celda lo sirve; esta carpeta es la copia.");
  L.push("Se repone re-vendorando desde /.well-known/, nunca editando acá. Ver collection/PUBLISHING.md.");
  return L;
}
