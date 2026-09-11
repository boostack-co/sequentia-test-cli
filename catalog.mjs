/**
 * Lee la colección Postman empaquetada y la convierte en el catálogo que el CLI
 * ejecuta.
 *
 * La idea de fondo: **la colección son datos, no documentación**. Agregar un
 * endpoint no debería requerir tocar el CLI, igual que agregar una herramienta
 * MCP no requiere tocar `call`. Este módulo es el que hace cierta esa promesa.
 *
 * Dos cosas que no son negociables y viven acá:
 *
 *  1. **El host jamás sale de la colección.** De acá salen el método, la ruta y
 *     la forma del cuerpo; el origen y el token salen SIEMPRE de la config del
 *     usuario. Si el host viniera del documento, una colección rotada o
 *     suplantada redirigiría un `sk_live_…` a donde quisiera. No está
 *     documentado y ya: `assertHostEsVariable` rompe la carga si alguna
 *     petición nombra otro host.
 *  2. **Lo que escribe, lo declara.** La guarda de `--yes` se alimenta del
 *     bloque `sq-test` de cada petición, no de una lista mantenida a mano. Una
 *     petición nueva que persiste o gasta créditos nace protegida.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** La colección que viaja en el paquete npm. */
export const COLLECTION_FILE = join(HERE, "collection", "sequentia-api.postman_collection.json");
export const ENVIRONMENT_FILE = join(HERE, "collection", "sequentia.postman_environment.json");

/**
 * El prefijo que la colección escribe en cada ruta y que el cliente REST vuelve
 * a poner. Se le quita acá para que la ruta interna sea la del endpoint y no la
 * de la URL, y para que un cambio de prefijo se toque en un solo lugar.
 */
const PREFIJO = ["api", "v1"];

/**
 * Variables que **no** se resuelven desde la colección ni desde `--var`.
 *
 * `baseUrl` es el host, que sale de la config: aceptarlo como variable sería
 * exactamente el agujero que la guarda de arriba cierra. `apiKey` es el token,
 * que el cliente pone como cabecera y que además nunca debe poder aparecer en
 * una línea de comando pegable.
 */
export const VARIABLES_RESERVADAS = new Set(["baseUrl", "apiKey"]);

/** La colección está mal formada, o pide algo que no se le permite pedir. */
export class CatalogError extends Error {
  constructor(message) {
    super(message);
    this.name = "CatalogError";
  }
}

/** Saca el bloque `sq-test` de una descripción y devuelve [metadata, prosa]. */
function extraerMetadata(descripcion, nombre) {
  const texto = String(descripcion ?? "");
  const m = texto.match(/```sq-test\n([\s\S]*?)\n```/);
  if (!m) throw new CatalogError(`"${nombre}" no declara su bloque sq-test`);
  let meta;
  try {
    meta = JSON.parse(m[1]);
  } catch (err) {
    throw new CatalogError(`El bloque sq-test de "${nombre}" no es JSON: ${err.message}`);
  }
  const prosa = texto.replace(m[0], "").trim();
  return [meta, prosa];
}

/**
 * La ruta del endpoint, sin host y sin el prefijo `/api/v1`.
 *
 * Acá es donde se descarta el host. La petición dice `{{baseUrl}}/api/v1/…`;
 * lo que sobrevive es `/…`, y el origen lo pone el cliente desde la config.
 */
function rutaDe(url, nombre) {
  const host = (url.host ?? []).join(".");
  if (host !== "{{baseUrl}}") {
    throw new CatalogError(
      `"${nombre}" apunta a "${host}" y no a {{baseUrl}}.\n` +
        `  El host sale SIEMPRE de la config del usuario: una colección que nombra un host propio ` +
        `podría redirigir la API key a donde quiera.`,
    );
  }
  const segmentos = url.path ?? [];
  for (let i = 0; i < PREFIJO.length; i++) {
    if (segmentos[i] !== PREFIJO[i]) {
      throw new CatalogError(`"${nombre}" no empieza con /${PREFIJO.join("/")}: /${segmentos.join("/")}`);
    }
  }
  return "/" + segmentos.slice(PREFIJO.length).join("/");
}

/** Toda `{{variable}}` que aparece en un valor, recursivamente. */
function variablesDe(valor, acc = new Set()) {
  if (typeof valor === "string") {
    for (const m of valor.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)) acc.add(m[1]);
  } else if (Array.isArray(valor)) {
    for (const v of valor) variablesDe(v, acc);
  } else if (valor && typeof valor === "object") {
    for (const v of Object.values(valor)) variablesDe(v, acc);
  }
  return acc;
}

/**
 * Reemplaza `{{variable}}` recorriendo la estructura ya parseada, **no** el
 * texto crudo del cuerpo.
 *
 * Postman sustituye sobre el texto, y ahí un valor con comillas o barras rompe
 * el JSON que se manda. Sustituyendo sobre el objeto, el resultado vuelve a
 * serializarse bien pase lo que pase.
 */
function sustituir(valor, vars) {
  if (typeof valor === "string") {
    return valor.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (todo, nombre) => (nombre in vars ? String(vars[nombre]) : todo));
  }
  if (Array.isArray(valor)) return valor.map((v) => sustituir(v, vars));
  if (valor && typeof valor === "object") {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, sustituir(v, vars)]));
  }
  return valor;
}

/** Convierte una petición de la colección en una entrada del catálogo. */
function entradaDe(nombre, item) {
  const req = item.request ?? {};
  const [meta, descripcion] = extraerMetadata(req.description, nombre);
  const ruta = rutaDe(req.url ?? {}, nombre);

  let body;
  if (req.body?.mode === "raw" && req.body.raw) {
    try {
      body = JSON.parse(req.body.raw);
    } catch (err) {
      throw new CatalogError(`El cuerpo de "${nombre}" no es JSON: ${err.message}`);
    }
  }

  const metodo = req.method;
  if (metodo !== "GET" && !("persists" in meta)) {
    // La misma regla que la colección declara: sin esto, «no escribe» sería
    // indistinguible de «nadie lo pensó».
    throw new CatalogError(`"${nombre}" es ${metodo} y no declara persists`);
  }

  const cabeceras = (req.header ?? [])
    .filter((h) => !/^(accept|content-type)$/i.test(h.key))
    .map((h) => ({ key: h.key, value: h.value }));

  // Un parámetro `disabled` en Postman está a la vista pero NO se manda. Si el
  // CLI lo mandara igual, la misma petición haría dos cosas distintas según
  // desde dónde se corra, y el comando que el menú imprime dejaría de
  // reproducir lo que hace Postman — que es la invariante 1 del proyecto.
  const query = (req.url?.query ?? [])
    .filter((q) => !q.disabled)
    .map((q) => ({ key: q.key, value: q.value, description: q.description }));

  const entrada = {
    nombre,
    metodo,
    ruta,
    query,
    body,
    cabeceras,
    auth: meta.auth !== false,
    scopes: meta.scopes ?? [],
    persists: meta.persists ?? null,
    spendsCredits: Boolean(meta.spendsCredits),
    internalRead: Boolean(meta.internalRead),
    captures: meta.captures ?? [],
    descripcion,
  };
  entrada.variables = variablesDe({ ruta, query, body, cabeceras });
  // `baseUrl` y `apiKey` ya no pueden llegar hasta acá —el host se descarta y
  // la auth la resuelve el cliente—, pero si alguna petición las emitiera en
  // otro lugar (una cabecera, el cuerpo) hay que verlo ahora y no en la red.
  for (const v of entrada.variables) {
    if (VARIABLES_RESERVADAS.has(v)) {
      throw new CatalogError(`"${nombre}" emite {{${v}}}, que es una variable reservada y no se resuelve desde la colección`);
    }
  }
  return entrada;
}

/**
 * Carga el catálogo desde un archivo.
 *
 * @param {string} [ruta] otra colección; por defecto, la empaquetada.
 * @returns {{ entradas: Map<string, object>, coleccion: object }}
 */
export function cargarCatalogo(ruta = COLLECTION_FILE) {
  if (!existsSync(ruta)) {
    throw new CatalogError(`No encuentro la colección en ${ruta}`);
  }
  let coleccion;
  try {
    coleccion = JSON.parse(readFileSync(ruta, "utf8"));
  } catch (err) {
    throw new CatalogError(`La colección no es JSON válido: ${err.message}`);
  }
  return catalogoDesde(coleccion);
}

/**
 * Arma el catálogo desde una colección ya parseada. Es lo que usa
 * `api collection --check` con lo que trae de Postman: antes se serializaba a
 * un temporal para volver a leerlo, solo porque el cargador pedía una ruta.
 */
export function catalogoDesde(coleccion) {
  if (!coleccion || typeof coleccion !== "object") {
    throw new CatalogError("La colección no es un objeto JSON");
  }
  const entradas = new Map();
  const recorrer = (items, prefijo) => {
    for (const it of items ?? []) {
      if (it.item) recorrer(it.item, `${prefijo}${it.name} / `);
      else entradas.set(prefijo + it.name, entradaDe(prefijo + it.name, it));
    }
  };
  recorrer(coleccion.item, "");
  if (entradas.size === 0) throw new CatalogError("La colección no declara ninguna petición");
  return { entradas, coleccion };
}

/**
 * Encuentra una petición por nombre, con tolerancia.
 *
 * Acepta el nombre completo (`Agent API / 1. Retrieve`), solo el de la petición
 * (`1. Retrieve`) o un fragmento, sin distinguir mayúsculas. Una coincidencia
 * ambigua **no elige por vos**: enumera las candidatas, porque en un banco de
 * pruebas correr otra cosa de la que se pidió invalida el experimento — y acá
 * algunas peticiones escriben.
 */
export function buscarPeticion(entradas, consulta) {
  const q = String(consulta ?? "").trim().toLowerCase();
  if (!q) throw new CatalogError("Falta el nombre de la petición");

  const nombres = [...entradas.keys()];
  const exacta = nombres.find((n) => n.toLowerCase() === q);
  if (exacta) return entradas.get(exacta);

  const porHoja = nombres.filter((n) => n.split(" / ").pop().toLowerCase() === q);
  if (porHoja.length === 1) return entradas.get(porHoja[0]);

  const candidatas = porHoja.length ? porHoja : nombres.filter((n) => n.toLowerCase().includes(q));
  if (candidatas.length === 1) return entradas.get(candidatas[0]);
  if (candidatas.length === 0) {
    throw new CatalogError(`No hay ninguna petición que coincida con "${consulta}".`);
  }
  throw new CatalogError(
    `"${consulta}" coincide con ${candidatas.length} peticiones; elegí una:\n` + candidatas.map((n) => `    ${n}`).join("\n"),
  );
}

/**
 * Resuelve las variables de una petición y devuelve lo que hay que mandar.
 *
 * @param {object} entrada
 * @param {object} vars valores de `--var`, que ganan sobre los defaults de la colección
 * @param {object} coleccion para leer los defaults del ámbito de colección
 */
export function resolverPeticion(entrada, vars, coleccion) {
  const defaults = Object.fromEntries((coleccion.variable ?? []).filter((v) => v.value !== "").map((v) => [v.key, v.value]));
  const valores = { ...defaults, ...vars };

  const faltantes = [...entrada.variables].filter((v) => !(v in valores) || valores[v] === "");
  if (faltantes.length) {
    // Antes de la red, siempre. Una variable sin resolver viaja como el texto
    // literal `{{kbId}}` dentro de la ruta, y el error que devuelve el servidor
    // se lee como un fallo suyo.
    throw new CatalogError(
      `Faltan variables para "${entrada.nombre}": ${faltantes.map((v) => `--var ${v}=…`).join(" ")}`,
    );
  }

  const ruta = sustituir(entrada.ruta, valores);
  const query = entrada.query
    .filter((q) => q.value !== undefined && q.value !== "")
    .map((q) => [q.key, sustituir(q.value, valores)]);
  const cadena = query.length ? "?" + query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";

  const cabeceras = Object.fromEntries(entrada.cabeceras.map((h) => [h.key, sustituir(h.value, valores)]));

  return {
    metodo: entrada.metodo,
    ruta: ruta + cadena,
    body: entrada.body === undefined ? undefined : sustituir(entrada.body, valores),
    cabeceras,
    auth: entrada.auth,
  };
}

/** Un resumen en una línea de lo que una petición cuesta y deja escrito. */
export function efectosDe(entrada) {
  const partes = [];
  if (entrada.persists) partes.push("escribe");
  if (entrada.spendsCredits) partes.push("gasta créditos");
  if (!entrada.auth) partes.push("sin credencial");
  return partes.join(" · ") || "—";
}

/** ¿Esta petición necesita `--yes`? Sale de la metadata, no de una lista. */
export function necesitaConfirmacion(entrada) {
  return Boolean(entrada.persists) || entrada.spendsCredits;
}
