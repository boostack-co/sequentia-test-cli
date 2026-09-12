#!/usr/bin/env node
/**
 * Guardas sobre la colección empaquetada. Corre **sin credenciales y sin red**,
 * así que un PR desde un fork la ejecuta de verdad.
 *
 *   node collection-lint.mjs [ruta-a-la-coleccion]
 *
 * Lo que ya hace `cargarCatalogo` NO se repite acá: el host `{{baseUrl}}`, el
 * prefijo `/api/v1`, el bloque `sq-test`, el cuerpo JSON, `persists` en toda
 * petición no-GET y las variables reservadas se validan al cargar, y una
 * colección que los viole ni siquiera llega a este archivo. Duplicarlo daría
 * dos fuentes de verdad para la misma regla, que es como empiezan a divergir.
 *
 * Lo que sí falta, y es lo de acá:
 *
 *  - Que toda `{{variable}}` que se emite se pueda resolver. `resolverPeticion`
 *    lo caza en el momento de correr una; esto lo caza para TODAS antes de
 *    publicar. Una variable inexistente viaja como el texto literal
 *    `{{loQueSea}}` dentro de la ruta, y la respuesta se lee como un fallo del
 *    servidor.
 *  - Que no sobre ninguna. Una variable declarada que nadie usa es una promesa
 *    al cliente que rellena el entorno y no ve efecto.
 *  - Que los defaults de URL sean **inalcanzables**. Un default que resolviera
 *    es uno que alguien deja puesto mientras su API key viaja hacia él como
 *    bearer token.
 *  - Que el `apiKey` del entorno viaje vacío y marcado como secreto.
 *  - Que la prosa no contradiga la metadata. Si una descripción miente sobre lo
 *    que una petición escribe o cuesta, el daño es de quien la corre.
 */
import { readFileSync } from "node:fs";
import { COLLECTION_FILE, CatalogError, ENVIRONMENT_FILE, cargarCatalogo } from "./catalog.mjs";

/**
 * Dominios que **no pueden** resolver, por RFC 2606 y RFC 6761. Es lo que hace
 * seguro dejar un default puesto en un artefacto público.
 */
const TLD_RESERVADOS = [".invalid", ".example", ".test", ".localhost"];
const DOMINIOS_RESERVADOS = ["example.com", "example.net", "example.org"];

const problemas = [];
const mal = (m) => problemas.push(m);

const rutaColeccion = process.argv[2] ?? COLLECTION_FILE;
let entradas, coleccion;
try {
  ({ entradas, coleccion } = cargarCatalogo(rutaColeccion));
} catch (err) {
  // Las guardas de `cargarCatalogo` son las mismas que las de acá y merecen la
  // misma presentación: en un log de CI, una traza de pila esconde el mensaje
  // que dice qué arreglar.
  if (!(err instanceof CatalogError)) throw err;
  console.error(`La colección no carga:\n\n  ✘ ${err.message}`);
  process.exit(1);
}
const entorno = JSON.parse(readFileSync(ENVIRONMENT_FILE, "utf8"));

// --- 1. Toda variable emitida se resuelve --------------------------------
// Tres orígenes, y el orden importa para el cliente pero no para esta guarda:
// el entorno, el ámbito de colección, y lo que un script captura al vuelo.
const definidas = new Set([
  ...(coleccion.variable ?? []).map((v) => v.key),
  ...(entorno.values ?? []).filter((v) => v.enabled !== false).map((v) => v.key),
]);

// Lo que los scripts escriben también cuenta como definido: `articleId` no
// tiene valor hasta que `List articles` lo captura.
const CAPTURA = /(?:collectionVariables|variables|environment)\.set\(\s*['"]([A-Za-z0-9_]+)['"]/g;
const textoScripts = JSON.stringify(coleccion);
for (const m of textoScripts.matchAll(CAPTURA)) definidas.add(m[1]);

const emitidas = new Set();
for (const entrada of entradas.values()) for (const v of entrada.variables) emitidas.add(v);

/**
 * Las variables que aparecen en la colección CRUDA, incluidas las de las
 * peticiones que el catálogo salta por declarar otro transporte.
 *
 * Sin esto, `{{mcpUrl}}` se denunciaba como variable que nadie usa: la usan las
 * siete peticiones de MCP, que este CLI no ejecuta y por eso no entran al
 * catálogo. El chequeo de «sobra» tiene que mirar el documento entero — lo que
 * el entorno declara es para quien abre Postman, no solo para quien corre el
 * CLI. El de «nadie la define», en cambio, sigue mirando el catálogo: ahí lo
 * que importa es que lo ejecutable se pueda resolver.
 */
const emitidasEnCrudo = new Set([...JSON.stringify(coleccion).matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]));

for (const entrada of entradas.values()) {
  for (const v of entrada.variables) {
    if (!definidas.has(v)) mal(`"${entrada.nombre}" emite {{${v}}} y nadie la define`);
  }
}

// --- 2. Y no sobra ninguna -----------------------------------------------
// Se miran también los scripts: `retrievalIdAt` no aparece en ninguna ruta ni
// en ningún cuerpo, solo en el script que la guarda y en el que la lee. Un
// chequeo que solo mirara URL/cabeceras/cuerpo la daría por muerta.
const LEE = /(?:collectionVariables|variables|environment|pm)\.(?:get|set|replaceIn)\(\s*['"]([A-Za-z0-9_{}]+)['"]/g;
const usadasEnScripts = new Set();
for (const m of textoScripts.matchAll(LEE)) usadasEnScripts.add(m[1].replace(/[{}]/g, ""));

for (const v of coleccion.variable ?? []) {
  if (!emitidasEnCrudo.has(v.key) && !usadasEnScripts.has(v.key)) {
    mal(`la colección declara {{${v.key}}} y ninguna petición ni script la usa`);
  }
}
for (const v of entorno.values ?? []) {
  // `baseUrl` y `apiKey` son del cliente, no de las peticiones: no las emite
  // nadie a propósito, y exigirles uso las convertiría en un falso positivo.
  if (v.key === "baseUrl" || v.key === "apiKey") continue;
  if (!emitidasEnCrudo.has(v.key) && !usadasEnScripts.has(v.key)) {
    mal(`el entorno declara {{${v.key}}} y ninguna petición ni script la usa`);
  }
}

// --- 3. Los defaults de URL son inalcanzables ----------------------------
const reservado = (valor) => {
  let host;
  try {
    host = new URL(valor).hostname.toLowerCase();
  } catch {
    return false;
  }
  return TLD_RESERVADOS.some((t) => host.endsWith(t)) || DOMINIOS_RESERVADOS.includes(host);
};

for (const v of [...(entorno.values ?? []), ...(coleccion.variable ?? [])]) {
  const valor = String(v.value ?? "");
  if (!/^https?:\/\//i.test(valor)) continue;
  if (!reservado(valor)) {
    mal(
      `{{${v.key}}} trae "${valor}" de default y ese host PUEDE resolver.\n` +
        `    Un default alcanzable es uno que alguien deja puesto mientras su API key viaja hacia él.\n` +
        `    Usá un dominio reservado: ${TLD_RESERVADOS.join(", ")} o example.com.`,
    );
  }
}

// --- 4. El apiKey viaja vacío y marcado como secreto ---------------------
const apiKey = (entorno.values ?? []).find((v) => v.key === "apiKey");
if (!apiKey) mal("el entorno no declara apiKey");
else {
  if (apiKey.value !== "") mal("el entorno trae un valor en apiKey: el artefacto es público");
  if (apiKey.type !== "secret") mal(`apiKey es type "${apiKey.type}" y tiene que ser "secret" para que Postman no la muestre`);
}

// --- 5. La prosa no contradice la metadata -------------------------------
// Esta guarda existe porque la contradicción ya pasó: el README decía "cuatro
// gastan créditos" mientras listaba tres. Es la clase de mentira que le cuesta
// a quien corre la colección, no a quien la escribe.
const NUMERO = { una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
const lista = [...entradas.values()];
const reales = {
  escriben: lista.filter((e) => e.persists).length,
  creditos: lista.filter((e) => e.spendsCredits).length,
};
const readme = readFileSync(new URL("./collection/README.md", import.meta.url), "utf8");
for (const [frase, clave] of [
  [/\*\*(\w+) peticiones? escriben?/i, "escriben"],
  [/\*\*(\w+) gastan créditos/i, "creditos"],
]) {
  const m = readme.match(frase);
  if (!m) continue;
  const dicho = NUMERO[m[1].toLowerCase()] ?? Number(m[1]);
  if (dicho !== reales[clave]) {
    mal(`collection/README.md dice "${m[1]}" para ${clave} y la metadata declara ${reales[clave]}`);
  }
}

// -------------------------------------------------------------------------
if (problemas.length) {
  console.error(`La colección tiene ${problemas.length} problema(s):\n`);
  for (const p of problemas) console.error(`  ✘ ${p}`);
  process.exit(1);
}
console.log(
  `Colección en verde: ${lista.length} peticiones · ${reales.escriben} escriben · ${reales.creditos} gastan créditos · ${definidas.size} variables definidas.`,
);
