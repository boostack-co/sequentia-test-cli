#!/usr/bin/env node
/**
 * Ejercita el COMPARADOR de `api collection --check` contra un servidor local.
 *
 * `collection-lint.mjs` valida la **forma** de la colección empaquetada; esto
 * valida la **comparación**, que es otra cosa y hasta ahora no la cubría nadie.
 * Es lo único que distingue «la colección está publicada» de «lo publicado es
 * lo que revisamos», así que una regresión acá no rompe nada visible: deja de
 * avisar, en silencio, que es el peor modo de falla de un control.
 *
 * No necesita Postman ni credenciales: `traerPublicada()` es un `fetch` plano,
 * así que alcanza con servir la colección del repo —mutada a propósito— desde
 * 127.0.0.1. El camino que se ejercita es el real y entero: fetch, desenvolver
 * el sobre de la API, armar el catálogo y comparar.
 *
 *   node collection-sync-smoke.mjs
 */
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SyncError, catalogoDe, comparar, formatearDerivas, traerPublicada } from "./collection-sync.mjs";

const ORIGINAL = fileURLToPath(new URL("./collection/sequentia-api.postman_collection.json", import.meta.url));
const SANDBOX = mkdtempSync(join(tmpdir(), "sq-test-sync-smoke-"));

let fallos = 0;
const comprobar = async (titulo, calcular, esperado) => {
  let real;
  try {
    real = typeof calcular === "function" ? await calcular() : calcular;
  } catch (err) {
    fallos++;
    console.error(`✘ ${titulo} — lanzó: ${err?.message ?? err}`);
    return;
  }
  if (JSON.stringify(real) !== JSON.stringify(esperado)) {
    fallos++;
    console.error(`✘ ${titulo}\n    esperaba ${JSON.stringify(esperado)}\n    recibí   ${JSON.stringify(real)}`);
  } else console.log(`✔ ${titulo}`);
};

/**
 * Levanta un servidor efímero que devuelve `cuerpo`, corre `fn` con su URL y lo
 * cierra pase lo que pase. Puerto 0: el sistema elige uno libre, así que dos
 * corridas en paralelo —la matriz del CI son seis— no se pisan.
 */
async function sirviendo(cuerpo, fn, { status = 200, tipo = "application/json" } = {}) {
  const srv = createServer((_, res) => {
    res.writeHead(status, { "Content-Type": tipo });
    res.end(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo));
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}/coleccion.json`);
  } finally {
    srv.closeAllConnections?.();
    await new Promise((ok) => srv.close(ok));
  }
}

const original = JSON.parse(readFileSync(ORIGINAL, "utf8"));
const copia = () => JSON.parse(JSON.stringify(original));

/** Las peticiones, aplanadas: la colección las agrupa en carpetas. */
function peticiones(coleccion) {
  const out = [];
  const recorrer = (nodos) => {
    for (const n of nodos) {
      if (n.item) recorrer(n.item);
      else out.push(n);
    }
  };
  recorrer(coleccion.item);
  return out;
}

/** Sirve `remota` y devuelve las derivas contra la colección del repo. */
const derivasDe = (remota) =>
  sirviendo(remota, async (url) => {
    const publicada = await traerPublicada(url);
    const local = catalogoDe(original, join(SANDBOX, "local.json"));
    const remoto = catalogoDe(publicada, join(SANDBOX, "remoto.json"));
    return comparar(local, remoto);
  });

const tipos = (derivas) => derivas.map((d) => d.tipo).sort();

// --- El control en la dirección contraria, primero -------------------------
// Va antes que las negativas a propósito: una guarda que grita siempre no es
// más segura, es otro defecto — y acá es EL defecto que importa, porque un
// control que siempre está en rojo se deja de mirar.
await comprobar("una copia idéntica no tiene derivas", async () => await derivasDe(original), []);

// Lo que Postman agrega solo. Es la razón por la que se compara el CATÁLOGO y
// no el JSON crudo: con un diff textual esta afirmación estaría en rojo SIEMPRE.
await comprobar(
  "el ruido de Postman no es deriva: uid, _postman_id, owner, updatedAt y el sobre {collection}",
  async () => {
    const c = copia();
    c._postman_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    c.info._postman_id = c._postman_id;
    c.info.updatedAt = new Date().toISOString();
    c.owner = "12345678";
    c.uid = `12345678-${c._postman_id}`;
    for (const [i, p] of peticiones(c).entries()) {
      p.uid = `12345678-${i}`;
      p.id = p.uid;
    }
    // El sobre que pone la API de Postman y que un export a mano no tiene.
    return await derivasDe({ collection: c });
  },
  [],
);

// --- Y ahora, ver rechazar una por una ------------------------------------
await comprobar(
  "una petición que está en el repo y no publicada",
  async () => {
    const c = copia();
    c.item.at(-1).item.pop();
    return tipos(await derivasDe(c));
  },
  ["solo-en-el-repo"],
);

await comprobar(
  "una petición publicada que no está en el repo — alguien editó en la UI",
  async () => {
    const c = copia();
    const nueva = JSON.parse(JSON.stringify(peticiones(c)[0]));
    nueva.name = "Inventada en la interfaz";
    c.item.at(-1).item.push(nueva);
    return tipos(await derivasDe(c));
  },
  ["solo-en-postman"],
);

await comprobar(
  "una descripción que difiere",
  async () => {
    const c = copia();
    const p = peticiones(c)[0];
    p.request.description = `${p.request.description ?? ""}\n\nTexto que no está en el repo.`;
    return tipos(await derivasDe(c));
  },
  ["descripcion"],
);

// El bloque `sq-test` vive DENTRO de la descripción, pero `extraerMetadata` lo
// separa de la prosa antes de armar el catálogo. Así que tocar un scope sale
// como deriva de `scopes` y NO además como deriva de descripción: la metadata
// no se cuenta dos veces. Importa que sea así — un cambio de scope reportado
// también como "la descripción difiere" mandaría a leer párrafos buscando algo
// que no está en los párrafos. El par con la afirmación de arriba es lo que fija
// el límite: prosa cambiada -> `descripcion` a secas; metadata cambiada ->
// `difiere` a secas.
await comprobar(
  "un scope cambiado sale como deriva de scopes, y NO también de descripción",
  async () => {
    const c = copia();
    const p = peticiones(c).find((x) => /"scopes"/.test(x.request?.description ?? ""));
    p.request.description = p.request.description.replace(/"scopes":\s*\[[^\]]*\]/, '"scopes":["scope.inventado"]');
    const derivas = await derivasDe(c);
    return [tipos(derivas), derivas[0]?.campo];
  },
  [["difiere"], "scopes"],
);

await comprobar(
  "una ruta cambiada",
  async () => {
    const c = copia();
    const p = peticiones(c)[0];
    p.request.url.raw = `${p.request.url.raw}/inventado`;
    p.request.url.path = [...p.request.url.path, "inventado"];
    return tipos(await derivasDe(c));
  },
  ["difiere"],
);

// Las variables de ámbito de colección gobiernan el encadenado de Postman: una
// que falte allá rompe la petición que la consume sin que ninguna otra cambie,
// así que sin esta comprobación la deriva sería invisible.
await comprobar(
  "una variable de colección que falta en lo publicado",
  async () => {
    const c = copia();
    c.variable = (c.variable ?? []).slice(0, -1);
    return tipos(await derivasDe(c));
  },
  ["variables"],
);

// --- Lo que se ve cuando hay deriva ---------------------------------------
// El mensaje es la mitad del control: uno que dice "hay deriva" sin nombrar
// cuál obliga a un diff a mano, que es lo que este comando existe para evitar.
await comprobar(
  "el informe nombra la petición y repite de qué lado está el original",
  async () => {
    const c = copia();
    c.item.at(-1).item.pop();
    const texto = formatearDerivas(await derivasDe(c)).join("\n");
    return [
      /está en el repo y NO publicada/.test(texto),
      /El repo es el original y Postman la copia/.test(texto),
      /Sin deriva/.test(texto),
    ];
  },
  [true, true, false],
);

await comprobar("sin derivas, el informe lo dice y no inventa una lista", () => formatearDerivas([]), [
  "✔ Sin deriva: lo publicado es lo que está en el repo.",
]);

// --- El otro extremo: lo que responde el servidor de Postman ---------------
// Estas ramas son las que se van a pisar de verdad el día que la access key
// caduque, y hasta hoy nunca se habían ejercido.
const falla = async (titulo, cuerpo, opts, esperado) =>
  await comprobar(
    titulo,
    async () => {
      try {
        await sirviendo(cuerpo, (url) => traerPublicada(url), opts);
        return "no lanzó";
      } catch (err) {
        return err instanceof SyncError ? (esperado.test(err.message) ? "ok" : `otro mensaje: ${err.message}`) : `otro error: ${err}`;
      }
    },
    "ok",
  );

await falla("un 403 sugiere que la clave fue rotada o revocada", "{}", { status: 403 }, /rotada o revocada/);
await falla("un 401 también", "{}", { status: 401 }, /rotada o revocada/);
await falla("un 500 se reporta con su código, sin la pista de la clave", "{}", { status: 500 }, /respondió 500/);
await falla(
  "el HTML de la página web en vez del JSON de la API",
  "<!doctype html><html><body>Postman</body></html>",
  { tipo: "text/html" },
  /la URL sea la de la API de Postman y no la de la página web/,
);

rmSync(SANDBOX, { recursive: true, force: true });

console.log(fallos ? `\n${fallos} fallos` : "\nTodo en verde.");
// `exitCode` y no `process.exit()`: con un servidor http de por medio, salir a
// la fuerza puede agarrar un handle a medio cerrar y hacer abortar a libuv.
process.exitCode = fallos ? 1 : 0;
