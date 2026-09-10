/**
 * `api doctor` — perfilar la credencial antes de que el 403 aparezca en medio
 * de otra cosa.
 *
 * Es lo que ni una colección ni un ejemplo dan por su cuenta. Los dos te dejan
 * correr una petición y ver que falla; ninguno te dice **por qué** falla, y las
 * causas que comparten status mandan a rotar keys que estaban bien.
 *
 * Tres decisiones que gobiernan todo lo de acá:
 *
 *  1. **El sondeo sale de la metadata de la colección, no de una lista.** Se
 *     prueban exactamente las peticiones que declaran no escribir y no gastar
 *     créditos. Un endpoint gratuito nuevo entra solo; uno que cobra no se
 *     sondea nunca por descuido. Un diagnóstico que factura no es un
 *     diagnóstico.
 *  2. **El `kbId` sale de la lista que la propia key devuelve.** Eso quita del
 *     medio la ambigüedad más cara del 403: contra una KB que la key acaba de
 *     enumerar, un 403 ya no puede ser "esa KB no está en tu lista blanca".
 *  3. **No se afirma "falta este scope" de algo que no se sondeó.** Cinco de
 *     los `agent.*` solo se alcanzan por endpoints que cobran o escriben, así
 *     que quedan explícitamente SIN SONDEAR. Un informe que los diera por
 *     ausentes mandaría a pedir permisos que quizá ya están.
 */

import { ApiTransportError } from "./api-client.mjs";
import { cargarCatalogo, resolverPeticion } from "./catalog.mjs";

/** Los tres estados posibles de un scope. El tercero no es un detalle. */
export const CONFIRMADO = "confirmado";
export const AUSENTE = "ausente";
export const SIN_SONDEAR = "sin-sondear";

/**
 * Dónde se consigue cada scope.
 *
 * Los formularios de creación de keys de Admin Studio **no son superconjunto
 * entre sí**: ninguna key creada desde uno solo los abre todos, y por eso
 * "probá otra vez con otra key" es un mal consejo.
 *
 * Este archivo decía antes que un scope que no figura en ningún formulario
 * había que "pedirlo por la vía interna", y **esa vía no existe**. No fue
 * inocuo: mandaba a esperar una gestión con otra persona en lugar de a hacer
 * una llamada de un minuto, que es el peor error que puede cometer un comando
 * cuyo trabajo es *decir dónde se consigue lo que falta*. Un consejo que no se
 * puede ejecutar es peor que no dar ninguno: el que no da ninguno manda a
 * preguntar, y el ejecutable-en-apariencia manda a esperar.
 *
 * Lo que sigue es solo lo que se puede afirmar sin copiar acá una tabla de
 * provisioning que este repo no puede mantener sincronizada — es público y
 * deliberadamente independiente. Nombrar qué formulario ofrece cada scope sería
 * una segunda copia de una verdad ajena, y la copia que quede vieja va a
 * mentir con la misma cara de certeza que la "vía interna".
 */
export const PROCEDENCIA = {
  "gaps.read": "no figura en los formularios de creación de keys, pero la API de creación de keys sí lo acepta",
  "kb.read_internal": "no figura en los formularios de creación de keys, pero la API de creación de keys sí lo acepta",
};

/** Lo que se dice de un `agent.*` que falta, cuando no hay algo más preciso. */
const PROCEDENCIA_AGENTE =
  "los `agent.*` se reparten entre los formularios, y varios no están en ninguno; " +
  "los que no, se conceden por la API de creación de keys";

/**
 * Advertencia que el informe emite siempre que `kb.read_internal` aparece.
 *
 * Provisionar una key creyendo que negar este scope oculta el contenido interno
 * es el error que este comando existe para no reforzar.
 */
export const AVISO_INTERNO =
  "`kb.read_internal` gobierna un puñado de peticiones y NO es una frontera de confidencialidad general.\n" +
  "  Lo que acota lo que una key alcanza es su lista blanca de KBs más un filtro de audiencia que falla cerrado.";

/**
 * Elige UNA petición por conjunto de scopes.
 *
 * Cuatro endpoints de analytics piden lo mismo; sondear los cuatro gasta cuota
 * y no agrega información. Ante empate gana la que necesita menos variables,
 * porque es la que menos depende de que un paso anterior haya salido bien.
 */
export function sondeosDe(entradas) {
  const porScopes = new Map();
  for (const entrada of entradas.values()) {
    if (entrada.persists || entrada.spendsCredits) continue; // regla 1
    if (!entrada.auth) continue; // health no dice nada de la credencial
    const clave = [...entrada.scopes].sort().join("+");
    const previa = porScopes.get(clave);
    if (!previa || entrada.variables.size < previa.variables.size) porScopes.set(clave, entrada);
  }
  // Primero los de un solo scope: son los que dan material para deducir cuál
  // falta cuando después falle uno que pide dos.
  return [...porScopes.values()].sort((a, b) => a.scopes.length - b.scopes.length || a.variables.size - b.variables.size);
}

/** Todo scope que la colección menciona, sondeable o no. */
export function scopesDeclarados(entradas) {
  const todos = new Set();
  for (const e of entradas.values()) for (const s of e.scopes) todos.add(s);
  return todos;
}

/**
 * Clasifica un fallo. Devuelve `{ clase, detalle }`.
 *
 * `clase` separa las tres cosas que se confunden y tienen remedios distintos:
 * la credencial, el plan del workspace, y los permisos de esa credencial.
 */
export function clasificar(err) {
  if (!(err instanceof ApiTransportError)) return { clase: "error", detalle: err?.message ?? String(err) };
  const { status, code } = err;
  if (status === 401) return { clase: "credencial", detalle: "la key no fue aceptada" };
  if (status === 402) {
    if (code === "MODULE_NOT_ENTITLED") return { clase: "plan", detalle: "el plan no incluye el módulo agéntico" };
    if (/credit/i.test(String(err.message))) return { clase: "creditos", detalle: "sin créditos de IA" };
    return { clase: "workspace", detalle: "el workspace no está operativo (suspendido o con SSO forzado)" };
  }
  if (status === 403) return { clase: "scope", detalle: "acceso denegado" };
  if (status === 404) return { clase: "no-encontrado", detalle: "no existe, o es de otro workspace" };
  return { clase: "error", detalle: err.message };
}

/**
 * El estado de cada scope, y **por qué**. Pura a propósito: la deducción es la
 * parte del `doctor` que puede equivocarse en silencio, y separarla de la red
 * es lo que permite ejercitarla en el CI —sin credenciales y sin servidor—
 * incluyendo la rama que la colección de hoy no alcanza.
 *
 * Un informe que dice "sin sondear" con el motivo equivocado es peor que uno
 * que no dice nada: manda a pedir permisos que quizá ya están, o a buscar en el
 * endpoint que no es. Los motivos se asignan en orden de precisión, y cada uno
 * solo pisa a un estado menos determinado que él.
 *
 * @param {object[]} sondeos lo que devolvió cada sondeo
 * @param {Set<string>} confirmados scopes con un 2xx detrás
 * @param {Map<string, object>} entradas el catálogo
 */
export function estadoDeScopes({ sondeos, confirmados, entradas }) {
  const scopes = {};
  // Un informe que dice "sin sondear" con el motivo equivocado es peor que uno
  // que no dice nada: manda a pedir permisos que quizá ya están, o a buscar en
  // el endpoint que no es. Los motivos se asignan en orden de precisión, y cada
  // uno solo pisa a un estado menos determinado que él.
  for (const s of scopesDeclarados(entradas)) scopes[s] = { estado: SIN_SONDEAR };

  // (a0) Un sondeo que ni se intentó, porque dependía de un paso anterior que
  //      falló. Es el caso más común cuando la credencial entera está mal: el
  //      primer sondeo da 401 y con él se pierde el {{kbId}} del que cuelgan
  //      casi todos los demás.
  for (const sondeo of sondeos) {
    if (sondeo.resultado !== SIN_SONDEAR) continue;
    for (const s of sondeo.scopes) scopes[s] = { estado: SIN_SONDEAR, motivo: sondeo.motivo };
  }

  // (a) Un sondeo gratuito que NO concluyó — 401, 402, 404. Estos scopes SÍ se
  //     ejercitaron; lo que no se pudo es evaluarlos, y decir "ninguna petición
  //     gratuita lo ejercita" sería falso.
  for (const sondeo of sondeos) {
    if (sondeo.resultado !== AUSENTE || sondeo.clase === "scope") continue;
    for (const s of sondeo.scopes) {
      scopes[s] = { estado: SIN_SONDEAR, motivo: `el sondeo no concluyó: ${sondeo.detalle}` };
    }
  }

  // (b) Los que solo se alcanzan pagando o escribiendo. Se anota únicamente si
  //     NINGUNA petición gratuita los ejercita: `rag.query` lo piden tanto el
  //     carril agéntico (que cobra) como la búsqueda léxica (que no), y
  //     atribuirlo al primero mandaría a mirar donde no es.
  const gratuitos = new Set();
  for (const e of entradas.values()) if (!e.persists && !e.spendsCredits && e.auth) for (const s of e.scopes) gratuitos.add(s);
  for (const entrada of entradas.values()) {
    if (!entrada.persists && !entrada.spendsCredits) continue;
    const razon = entrada.persists
      ? `solo se alcanza por "${entrada.nombre}", que escribe`
      : `solo se alcanza por "${entrada.nombre}", que gasta créditos`;
    for (const s of entrada.scopes) {
      if (gratuitos.has(s)) continue;
      if (scopes[s]?.estado === SIN_SONDEAR && !scopes[s].motivo) {
        scopes[s] = { estado: SIN_SONDEAR, motivo: razon };
      }
    }
  }

  // (c) Ausentes. Un 403 sobre una petición que pide dos scopes no dice cuál
  //     falló; si el otro ya se confirmó por su cuenta queda uno solo y el
  //     informe puede nombrarlo, y si no, se dicen los candidatos en vez de
  //     elegir uno.
  for (const sondeo of sondeos) {
    if (sondeo.resultado !== AUSENTE || sondeo.clase !== "scope") continue;
    const candidatos = sondeo.scopes.filter((s) => !confirmados.has(s));
    if (candidatos.length === 1) {
      scopes[candidatos[0]] = { estado: AUSENTE, via: sondeo.peticion };
    } else {
      for (const s of candidatos) scopes[s] = { estado: AUSENTE, via: sondeo.peticion, ambiguo: candidatos };
    }
  }

  // (d) Confirmados, al final: un 2xx es la evidencia más fuerte y gana sobre
  //     cualquier deducción anterior.
  for (const s of confirmados) scopes[s] = { estado: CONFIRMADO };

  return scopes;
}

/**
 * Corre el diagnóstico. No lanza por un fallo de sondeo: un 403 **es** el dato.
 *
 * Solo se rinde si la celda no responde, porque ahí no hay nada que perfilar y
 * seguir sondeando produciría una lista de fallos que culpan a la credencial.
 */
export async function diagnosticar(client, { onPaso = () => {} } = {}) {
  const { entradas, coleccion } = cargarCatalogo();
  const informe = {
    celda: { url: client.baseUrl, alcanzable: false },
    credencial: { estado: null, detalle: null },
    scopes: {},
    sondeos: [],
    rateLimit: null,
    avisos: [],
  };

  // --- Fase 1: ¿responde la celda? Sin credencial, a propósito. ------------
  onPaso("celda", "GET /health, sin credencial");
  try {
    const { data } = await client.health();
    informe.celda.alcanzable = true;
    informe.celda.health = data;
  } catch (err) {
    informe.celda.error = err.message;
    // Sin celda no hay credencial que perfilar: los sondeos darían una lista de
    // fallos que parecen de permisos y son de URL.
    return informe;
  }

  // --- Fase 2 y 3: sondeos, en orden de dependencia -----------------------
  const vars = {};
  const confirmados = new Set();

  for (const entrada of sondeosDe(entradas)) {
    const faltan = [...entrada.variables].filter((v) => !(v in vars));
    if (faltan.length) {
      informe.sondeos.push({
        peticion: entrada.nombre,
        scopes: entrada.scopes,
        resultado: SIN_SONDEAR,
        motivo: `no se pudo resolver ${faltan.map((v) => `{{${v}}}`).join(", ")} — dependía de un sondeo anterior`,
      });
      continue;
    }

    onPaso("sondeo", `${entrada.metodo} ${entrada.nombre}`);
    const peticion = resolverPeticion(entrada, vars, coleccion);
    try {
      const { data } = await client.request(peticion.metodo, peticion.ruta, {
        body: peticion.body,
        headers: peticion.cabeceras,
      });
      for (const s of entrada.scopes) confirmados.add(s);
      informe.sondeos.push({ peticion: entrada.nombre, scopes: entrada.scopes, resultado: CONFIRMADO });
      cosechar(entrada, data, vars);
    } catch (err) {
      const { clase, detalle } = clasificar(err);
      informe.sondeos.push({ peticion: entrada.nombre, scopes: entrada.scopes, resultado: AUSENTE, clase, detalle });
      // Un fallo que NO es de scope habla del workspace entero, no de un
      // permiso: se registra una vez y no se repite por cada sondeo.
      if (clase !== "scope" && clase !== "no-encontrado" && !informe.credencial.estado) {
        informe.credencial = { estado: clase, detalle };
      }
    }
  }

  if (!informe.credencial.estado) {
    informe.credencial = confirmados.size
      ? { estado: "ok", detalle: `${confirmados.size} scopes confirmados` }
      : { estado: "sin-permisos", detalle: "la key es válida pero ningún sondeo pasó" };
  }

  informe.scopes = estadoDeScopes({ sondeos: informe.sondeos, confirmados, entradas });
  informe.alternativas = alternativasDe(entradas);

  informe.rateLimit = client.rateLimit ?? null;
  if (informe.scopes["kb.read_internal"]) informe.avisos.push(AVISO_INTERNO);
  return informe;
}

/** Guarda de la respuesta lo que otro sondeo va a necesitar. */
function cosechar(entrada, data, vars) {
  // El kbId sale de la lista que la propia key devolvió: contra una KB que
  // acaba de enumerar, un 403 posterior ya no puede ser la lista blanca.
  if (!("kbId" in vars)) {
    const kb = primerId(data, ["knowledgeBases", "data", "items", "results"]);
    if (kb) vars.kbId = kb;
  }
  if (entrada.captures?.includes("articleId") && !("articleId" in vars)) {
    const art = primerId(data, ["articles", "data", "items", "results"]);
    if (art) vars.articleId = art;
  }
}

/** El `id` del primer elemento, mirando las formas de envoltorio conocidas. */
function primerId(data, claves) {
  if (Array.isArray(data)) return data[0]?.id ?? null;
  for (const k of claves) {
    const v = data?.[k];
    if (Array.isArray(v) && v.length) return v[0]?.id ?? null;
    if (Array.isArray(v?.items) && v.items.length) return v.items[0]?.id ?? null;
  }
  return null;
}

/**
 * Para cada scope, los OTROS que abren alguna de sus mismas peticiones.
 *
 * La colección declara los scopes de cada petición **en OR** —alcanza con tener
 * uno—, así que un scope que falta puede no hacer ninguna falta: si otro de los
 * que esa petición acepta ya está confirmado, el endpoint se alcanza igual.
 *
 * Sale del catálogo del repo, no de una tabla escrita a mano acá. Es la
 * diferencia entre un dato que se mantiene solo cuando la colección cambia y
 * uno que hay que acordarse de actualizar — y acordarse es justo lo que no
 * pasó con la "vía interna".
 */
export function alternativasDe(entradas) {
  const alt = {};
  for (const e of entradas.values()) {
    if (e.scopes.length < 2) continue;
    for (const s of e.scopes) {
      (alt[s] ??= new Set());
      for (const otro of e.scopes) if (otro !== s) alt[s].add(otro);
    }
  }
  return Object.fromEntries(Object.entries(alt).map(([s, v]) => [s, [...v]]));
}

/**
 * Dónde se consigue un scope que falta — o por qué no hace falta conseguirlo.
 *
 * El contexto es opcional para que llamarla con el scope solo siga andando; sin
 * él simplemente no puede decir lo primero, que es lo más útil que sabe decir.
 */
export function comoConseguir(scope, { alternativas, scopes } = {}) {
  // Lo primero, porque cambia la respuesta entera: pedir un permiso que no hace
  // falta cuesta una gestión y no arregla nada.
  const cubren = (alternativas?.[scope] ?? []).filter((otro) => scopes?.[otro]?.estado === CONFIRMADO);
  if (cubren.length) {
    return (
      `no hace falta pedirlo: la key ya tiene ${cubren.join(" y ")}, ` +
      "y la colección declara esos scopes en OR — alcanza con uno para abrir las mismas peticiones"
    );
  }
  if (PROCEDENCIA[scope]) return PROCEDENCIA[scope];
  if (scope.startsWith("agent.")) return PROCEDENCIA_AGENTE;
  return (
    "las pantallas de creación de keys ofrecen listas distintas y ninguna es superconjunto de la otra: " +
    "si el scope no está en la que usaste, probá la otra, y si no está en ninguna se concede por la API de creación de keys"
  );
}

// ---------------------------------------------------------------------------
// Presentación
// ---------------------------------------------------------------------------
const ICONO = { [CONFIRMADO]: "✔", [AUSENTE]: "✘", [SIN_SONDEAR]: "·" };

/**
 * El informe en texto. Devuelve un array de líneas para que el llamante decida
 * a qué flujo van: bajo `--json` la narración va a stderr y el documento a
 * stdout, que es la invariante 6.
 */
export function formatearInforme(informe) {
  const L = [];
  L.push(`Celda: ${informe.celda.url}`);
  if (!informe.celda.alcanzable) {
    L.push(`  ✘ no responde — ${informe.celda.error}`);
    L.push("");
    L.push("El diagnóstico para acá: sin celda no hay credencial que perfilar.");
    L.push("Es un problema de URL, no de key. Revisá SQ_TEST_API_URL.");
    return L;
  }
  L.push("  ✔ responde /health sin credencial");
  L.push("");

  const cred = informe.credencial;
  const titulo = {
    ok: "✔ la key es válida y tiene permisos",
    "sin-permisos": "✘ la key es válida pero ningún sondeo pasó",
    credencial: "✘ la key no fue aceptada (401)",
    plan: "✘ el plan del workspace no incluye el módulo agéntico (402)",
    creditos: "✘ sin créditos de IA (402) — la key y los permisos están bien",
    workspace: "✘ el workspace no está operativo (402) — la key es válida",
  };
  L.push(`Credencial: ${titulo[cred.estado] ?? `? ${cred.estado}`}`);
  if (cred.estado === "plan") L.push("  Es del plan, no de la key: pedir más scopes no lo arregla.");
  if (cred.estado === "workspace") L.push("  Lo que está cerrado es el workspace: suspendido, o forzando SSO.");
  L.push("");

  L.push("Scopes");
  const orden = { [CONFIRMADO]: 0, [AUSENTE]: 1, [SIN_SONDEAR]: 2 };
  const filas = Object.entries(informe.scopes).sort(
    (a, b) => orden[a[1].estado] - orden[b[1].estado] || a[0].localeCompare(b[0]),
  );
  const ancho = Math.max(...filas.map(([s]) => s.length), 10);
  for (const [scope, info] of filas) {
    let nota = "";
    if (info.estado === AUSENTE) nota = info.ambiguo ? `hace falta UNO de: ${info.ambiguo.join(", ")}` : "no lo tiene";
    if (info.estado === SIN_SONDEAR) nota = info.motivo ?? "ninguna petición gratuita lo ejercita";
    // El dato que le falta a la fila: que un scope quede sin sondear NO
    // significa que haga falta conseguirlo. Los `agent.*` que cobran son
    // exactamente los que nunca se pueden sondear Y los que tienen una
    // alternativa más amplia, así que sin esta línea el informe deja abierta la
    // única pregunta que el usuario se hace mirándolos: «¿tengo que pedir esto?».
    const cubren = (informe.alternativas?.[scope] ?? []).filter((o) => informe.scopes[o]?.estado === CONFIRMADO);
    if (cubren.length && info.estado !== CONFIRMADO) {
      nota += `${nota ? " · " : ""}pero ${cubren.join(" y ")} abre esas peticiones igual: no hace falta`;
    }
    L.push(`  ${ICONO[info.estado]} ${scope.padEnd(ancho)}  ${nota}`);
  }
  L.push("");

  const faltan = filas.filter(([, i]) => i.estado === AUSENTE).map(([s]) => s);
  if (faltan.length) {
    L.push("Cómo conseguir lo que falta");
    for (const s of faltan) {
      L.push(`  ${s}: ${comoConseguir(s, { alternativas: informe.alternativas, scopes: informe.scopes })}`);
    }
    L.push("");
  }

  const sinSondear = filas.filter(([, i]) => i.estado === SIN_SONDEAR).map(([s]) => s);
  if (sinSondear.length) {
    L.push(`Sin sondear (${sinSondear.length}) — es una decisión, no un olvido:`);
    L.push("  solo se sondean peticiones que la colección declara sin escrituras y sin créditos.");
    L.push("  Un diagnóstico que factura no es un diagnóstico.");
    L.push("");
  }

  if (informe.rateLimit) {
    const r = informe.rateLimit;
    L.push(`Presupuesto de rate limit: ${r.remaining ?? "?"}/${r.limit ?? "?"} restantes${r.reset ? `, reset ${r.reset}` : ""}`);
    L.push("  Ojo: son dos techos con relojes distintos — el de la credencial y uno por IP en el borde.");
    L.push("  Esta cabecera es la del primero; el segundo no se ve hasta que pega.");
    L.push("");
  }

  for (const aviso of informe.avisos) L.push(`Aviso: ${aviso}`, "");
  return L;
}
