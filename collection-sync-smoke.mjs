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
import { CatalogError, catalogoDesde } from "./catalog.mjs";

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
    const local = catalogoDe(original);
    const remoto = catalogoDe(publicada);
    return comparar(local, remoto);
  });

const tipos = (derivas) => derivas.map((d) => d.tipo).sort();

/**
 * Quita la última petición REST y devuelve la colección.
 *
 * Antes esto era `c.item.at(-1).item.pop()`, y dejó de servir cuando la
 * colección canónica sumó la carpeta MCP al final: el catálogo salta lo que no
 * es REST, así que quitar una de MCP no produce deriva y el fixture medía cero
 * contra cero. La carpeta que se toca tiene que ser una que el CLI ejecute.
 */
function sinLaUltimaRest(c) {
  for (let i = c.item.length - 1; i >= 0; i--) {
    const f = c.item[i];
    const rest = (f.item ?? []).filter((p) => {
      const m = String(p.request?.description ?? "").match(/```sq-test\n([\s\S]*?)\n```/);
      if (!m) return true;
      try {
        return (JSON.parse(m[1]).transport ?? "rest") === "rest";
      } catch {
        return true;
      }
    });
    if (rest.length) {
      f.item.splice(f.item.indexOf(rest.at(-1)), 1);
      return c;
    }
  }
  throw new Error("la colección no tiene ninguna petición REST");
}

/** Afirma que armar el catálogo con esa colección revienta con CatalogError. */
const rechazaCatalogo = (titulo, fn) => {
  try {
    fn();
    fallos++;
    console.error(`✘ ${titulo} — NO rechazó`);
  } catch (err) {
    if (err instanceof CatalogError) console.log(`✔ ${titulo}`);
    else {
      fallos++;
      console.error(`✘ ${titulo} — lanzó otra cosa: ${err}`);
    }
  }
};

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
    sinLaUltimaRest(c);
    return tipos(await derivasDe(c));
  },
  ["solo-en-el-repo"],
);

await comprobar(
  "una petición que sirve la celda y no está en la copia del repo",
  async () => {
    const c = copia();
    const nueva = JSON.parse(JSON.stringify(peticiones(c)[0]));
    nueva.name = "Servida por la celda y ausente del repo";
    c.item.at(-1).item.push(nueva);
    return tipos(await derivasDe(c));
  },
  ["solo-en-la-celda"],
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
    sinLaUltimaRest(c);
    const texto = formatearDerivas(await derivasDe(c)).join("\n");
    return [
      /está en el repo y la celda NO la sirve/.test(texto),
      /El original lo genera la plataforma y la celda lo sirve/.test(texto),
      /Sin deriva/.test(texto),
    ];
  },
  [true, true, false],
);

await comprobar("sin derivas, el informe lo dice y no inventa una lista", () => formatearDerivas([]), [
  "✔ Sin deriva: la copia del repo es la que sirve la celda.",
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

await falla("un 403 dice que NO es tu key: esa ruta es pública", "{}", { status: 403 }, /NO es tu key/);
await falla("un 401 también", "{}", { status: 401 }, /NO es tu key/);
await falla("un 500 se reporta con su código, sin esa pista", "{}", { status: 500 }, /respondió 500/);
await falla(
  "un HTML en vez del JSON — el origen no es una celda",
  "<!doctype html><html><body>Not a cell</body></html>",
  { tipo: "text/html" },
  /el origen sea el de una celda y la ruta \/\.well-known\/postman-collection\.json/,
);

// --- Los query params: los manda igual que Postman, y el control los ve ------
//
// Un parámetro `disabled` está a la vista en Postman pero NO se manda. El
// catálogo lo ignoraba, así que la MISMA petición hacía dos cosas distintas
// según desde dónde se corriera — y el comando que el menú imprime dejaba de
// reproducir lo que Postman hace, que es la invariante 1 del proyecto.
await comprobar(
  "un query param `disabled` no viaja en la petición",
  async () => {
    const c = copia();
    const p = peticiones(c).find((x) => x.request?.url?.query?.length);
    p.request.url.query = [
      { key: "vivo", value: "1" },
      { key: "apagado", value: "2", disabled: true },
    ];
    const cat = catalogoDe(c, join(SANDBOX, "dis.json"));
    // Las entradas se indexan por "Carpeta / Nombre", no por el nombre solo.
    const clave = [...cat.entradas.keys()].find((k) => k.endsWith(`/ ${p.name}`));
    return cat.entradas.get(clave).query.map((q) => q.key);
  },
  ["vivo"],
);

// `query` no estaba en los campos comparados, y era un agujero: los parámetros
// no forman parte de `ruta` —que es solo el path—, así que cambiarlos en
// Postman dejaba el chequeo en verde. Son justo lo que gobierna qué devuelve
// una petición.
await comprobar(
  "un query param cambiado en lo publicado es deriva",
  async () => {
    const c = copia();
    const p = peticiones(c).find((x) => x.request?.url?.query?.length);
    p.request.url.query = [...p.request.url.query, { key: "inventado", value: "1" }];
    const derivas = await derivasDe(c);
    return [tipos(derivas), derivas[0]?.campo];
  },
  [["difiere"], "query"],
);
// Y el control en la otra dirección: desactivar un parámetro TAMBIÉN es deriva.
// Si no lo fuera, alguien podría apagar `?limit=` en la interfaz y el chequeo
// seguiría en verde mientras la colección publicada devuelve otra cosa.
await comprobar(
  "desactivar un query param en lo publicado también es deriva",
  async () => {
    const c = copia();
    const p = peticiones(c).find((x) => x.request?.url?.query?.length);
    p.request.url.query = p.request.url.query.map((q) => ({ ...q, disabled: true }));
    return tipos(await derivasDe(c));
  },
  ["difiere"],
);

// --- El artefacto es UNO y sirve a dos públicos ------------------------------
//
// La colección canónica que genera la plataforma trae también la carpeta MCP:
// para una persona en Postman es lo único que hace tocable ese protocolo a mano
// —trae el handshake y arrastra el `mcp-session-id`—. Este CLI no la ejecuta:
// MCP no es otra ruta, es otro transporte, y su carril propio ya lo cubre con
// cliente, menú y comandos que no leen esta colección.
//
// Por eso el catálogo descarta lo no-REST ANTES de validar. Si validara
// primero, una petición de otro transporte —que no cumple ni tiene por qué
// cumplir las reglas del carril REST— abortaría la carga ENTERA.
const conTransporte = (transport, extra = {}) => ({
  name: "Prueba",
  request: {
    method: "GET",
    url: { raw: "{{baseUrl}}/api/v1/health", host: ["{{baseUrl}}"], path: ["api", "v1", "health"] },
    description:
      "x\n\n```sq-test\n" + JSON.stringify({ scopes: [], persists: null, spendsCredits: false, ...(transport ? { transport } : {}) }) + "\n```",
    ...extra,
  },
});
const catalogoCon = (items) => catalogoDesde({ item: items });

await comprobar(
  "una petición `transport: rest` entra al catálogo",
  () => catalogoCon([conTransporte("rest")]).entradas.size,
  1,
);
// El default importa: la colección escrita a mano no trae el campo, y el
// comportamiento sin él tiene que ser el que ya andaba.
await comprobar(
  "sin el campo `transport`, se asume rest y entra igual",
  () => catalogoCon([conTransporte(null)]).entradas.size,
  1,
);
await comprobar(
  "una petición `transport: mcp` NO entra",
  () => catalogoCon([conTransporte("rest"), conTransporte("mcp")]).entradas.size,
  1,
);

// El caso que motiva el orden: una petición MCP real apunta a `{{mcpUrl}}` y
// NO empieza por /api/v1. Validarla antes de descartarla rompía la colección
// entera con un error sobre una petición que este cargador no va a ejecutar.
await comprobar(
  "una MCP con host y ruta ajenos al carril REST no rompe la carga",
  () => {
    const mcp = conTransporte("mcp");
    mcp.request.method = "POST";
    mcp.request.url = { raw: "{{mcpUrl}}", host: ["{{mcpUrl}}"] };
    mcp.request.body = { mode: "raw", raw: '{"jsonrpc":"2.0","method":"initialize"}' };
    return catalogoCon([conTransporte("rest"), mcp]).entradas.size;
  },
  1,
);

// El control en la dirección contraria, y es el que impide que este descarte se
// convierta en una vía para colar peticiones rotas: lo que NO declara
// transporte sigue validándose entero. Un `{{mcpUrl}}` sin marcar tiene que
// romper, porque entonces sí es una petición REST que nombra un host que no es
// el de la config.
rechazaCatalogo("un host ajeno SIN marcar como mcp sigue rompiendo la carga", () => {
  const suelta = conTransporte(null);
  suelta.request.url = { raw: "{{mcpUrl}}", host: ["{{mcpUrl}}"] };
  return catalogoCon([suelta]);
});
rechazaCatalogo("y una sin bloque sq-test también, con su mensaje", () =>
  catalogoCon([{ name: "Sin bloque", request: { method: "GET", url: { host: ["{{baseUrl}}"], path: ["api", "v1", "x"] } } }]),
);

rmSync(SANDBOX, { recursive: true, force: true });

console.log(fallos ? `\n${fallos} fallos` : "\nTodo en verde.");
// `exitCode` y no `process.exit()`: con un servidor http de por medio, salir a
// la fuerza puede agarrar un handle a medio cerrar y hacer abortar a libuv.
process.exitCode = fallos ? 1 : 0;
