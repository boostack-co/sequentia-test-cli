#!/usr/bin/env node
/**
 * Ejercita la deducción de `api doctor` con sondeos **fabricados**.
 *
 * La deducción es la parte del comando que puede equivocarse en silencio: un
 * motivo mal asignado no falla, solo miente, y manda a pedir un permiso que ya
 * estaba o a mirar el endpoint que no es. Al ser pura, se puede probar sin
 * credencial y sin red — así que corre en el CI, en toda la matriz.
 *
 * Incluye la rama que la colección de HOY no alcanza: cuando faltan los dos
 * scopes de una petición que pide dos, el informe tiene que decir que hay dos
 * candidatos en vez de elegir uno. Con el catálogo actual `kb.read` siempre se
 * confirma antes por su cuenta, así que sin este guion esa rama viajaría sin
 * haberse ejecutado nunca.
 *
 *   node doctor-smoke.mjs
 */
import { ApiTransportError } from "./api-client.mjs";
import { diagnosticar } from "./doctor.mjs";
import {
  AUSENTE,
  CONFIRMADO,
  SIN_SONDEAR,
  PROCEDENCIA,
  alternativasDe,
  clasificar,
  formatearInforme,
  comoConseguir,
  estadoDeScopes,
} from "./doctor.mjs";
import { cargarCatalogo } from "./catalog.mjs";

const { entradas } = cargarCatalogo();
let fallos = 0;

/**
 * El valor se calcula ACÁ DENTRO, y un throw cuenta como fallo de ESTA
 * afirmación en vez de tumbar la corrida. Es la misma forma que ya usan
 * `loop-smoke` y `collection-sync-smoke`, y este guion era el único que no la
 * tenía: una regresión que hiciera lanzar a `estadoDeScopes` mataba el proceso
 * antes de imprimir nada, y el CI se ponía rojo sin decir cuál aserción cayó.
 */
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

// --- 1. Deducción por resta: la petición pide dos, uno ya está confirmado ---
{
  const scopes = estadoDeScopes({
    entradas,
    confirmados: new Set(["kb.read"]),
    sondeos: [
      { peticion: "Knowledge Bases / List knowledge bases", scopes: ["kb.read"], resultado: CONFIRMADO },
      { peticion: "Agent API / 4. Index status", scopes: ["agent.index_status", "kb.read"], resultado: AUSENTE, clase: "scope" },
    ],
  });
  await comprobar("nombra el scope que falta y no el confirmado", () => scopes["agent.index_status"].estado, AUSENTE);
  await comprobar("no marca ausente el que sí tiene", () => scopes["kb.read"].estado, CONFIRMADO);
  await comprobar("y no lo declara ambiguo", () => scopes["agent.index_status"].ambiguo, undefined);
}

// --- 2. La rama que el catálogo de hoy no alcanza: faltan los dos ----------
{
  const scopes = estadoDeScopes({
    entradas,
    confirmados: new Set(),
    sondeos: [
      { peticion: "Agent API / 4. Index status", scopes: ["agent.index_status", "kb.read"], resultado: AUSENTE, clase: "scope" },
    ],
  });
  await comprobar("con dos candidatos no elige", () => scopes["agent.index_status"].ambiguo, ["agent.index_status", "kb.read"]);
  await comprobar("y lo dice de los dos", () => scopes["kb.read"].ambiguo, ["agent.index_status", "kb.read"]);
}

// --- 3. Un sondeo que no concluyó NO es un scope ausente -------------------
{
  const scopes = estadoDeScopes({
    entradas,
    confirmados: new Set(),
    sondeos: [
      { peticion: "Knowledge Bases / List knowledge bases", scopes: ["kb.read"], resultado: AUSENTE, clase: "credencial", detalle: "la key no fue aceptada" },
    ],
  });
  await comprobar("un 401 deja el scope sin sondear, no ausente", () => scopes["kb.read"].estado, SIN_SONDEAR);
  await comprobar("y dice que el sondeo no concluyó", () => scopes["kb.read"].motivo, "el sondeo no concluyó: la key no fue aceptada");
}

// --- 4. Un sondeo saltado explica POR QUÉ se saltó -------------------------
{
  const scopes = estadoDeScopes({
    entradas,
    confirmados: new Set(),
    sondeos: [
      { peticion: "Knowledge Bases / Knowledge gaps", scopes: ["gaps.read"], resultado: SIN_SONDEAR, motivo: "no se pudo resolver {{kbId}} — dependía de un sondeo anterior" },
    ],
  });
  await comprobar("propaga el motivo del sondeo saltado", () => scopes["gaps.read"].motivo, "no se pudo resolver {{kbId}} — dependía de un sondeo anterior");
}

// --- 5. `rag.query` no se atribuye al endpoint que cobra -------------------
// Lo piden la búsqueda léxica (gratuita) y el carril agéntico (que cobra).
// Decir "solo se alcanza por 1. Retrieve" mandaría a mirar donde no es.
{
  const scopes = estadoDeScopes({ entradas, confirmados: new Set(), sondeos: [] });
  const motivo = scopes["rag.query"].motivo ?? "";
  await comprobar("rag.query no se atribuye a un endpoint que cobra", () => /gasta créditos/.test(motivo), false);
  await comprobar("agent.retrieve sí, porque no hay petición gratuita que lo ejercite", () => /gasta créditos/.test(scopes["agent.retrieve"].motivo ?? ""), true);
}

// --- 6. Nunca se afirma "ausente" de algo que no se sondeó -----------------
{
  const scopes = estadoDeScopes({ entradas, confirmados: new Set(), sondeos: [] });
  const ausentes = Object.entries(scopes).filter(([, v]) => v.estado === AUSENTE);
  await comprobar("sin sondeos no hay ningún scope ausente", () => ausentes.length, 0);
}

// --- 7. Todo scope declarado sabe decir dónde se consigue ------------------
{
  const scopes = estadoDeScopes({ entradas, confirmados: new Set(), sondeos: [] });
  const mudos = Object.keys(scopes).filter((s) => !comoConseguir(s));
  await comprobar("ningún scope se queda sin vía", () => mudos, []);
}

// --- 8. Un consejo tiene que poder ejecutarse -----------------------------
// La versión anterior mandaba a "pedirlo por la vía interna", y esa vía no
// existe. El daño de un consejo así no es que sea inútil: es que PARECE
// ejecutable, así que manda a esperar una gestión en vez de a preguntar. Se
// afirma por texto porque lo que se rompió fue exactamente el texto.
{
  const scopes = estadoDeScopes({ entradas, confirmados: new Set(), sondeos: [] });
  const conViaInexistente = Object.keys(scopes).filter((s) => /vía interna/i.test(comoConseguir(s)));
  await comprobar("ningún scope manda a una vía que no existe", () => conViaInexistente, []);
  await comprobar(
    "y el que no está en ningún formulario nombra la vía que sí existe", () => /API de creación de keys/.test(PROCEDENCIA["gaps.read"]),
    true,
  );
}

// --- 9. Las alternativas salen del catálogo, no de una tabla a mano --------
// La colección declara los scopes de cada petición en OR. Derivarlas del
// catálogo es lo que hace que el dato no se desactualice: este repo es público
// e independiente, y una tabla de provisioning escrita acá volvería a mentir en
// cuanto la plataforma cambie — que es la historia del punto 8.
{
  const alt = alternativasDe(entradas);
  await comprobar("`/agent/retrieve` declara rag.query como alternativa", () => alt["agent.retrieve"], ["rag.query"]);
  await comprobar("y la relación es simétrica", () => alt["rag.query"].includes("agent.retrieve"), true);
  await comprobar("`/agent/gap-report` declara gaps.write", () => alt["agent.gap_report"], ["gaps.write"]);
  // `agent.feedback` es el único endpoint agéntico SIN alternativa: el servidor
  // no le declara fallback. Que no aparezca acá no es un olvido — es la razón
  // por la que ese scope sí hay que conseguirlo.
  await comprobar("`/agent/feedback` no tiene alternativa, y por eso no figura", () => alt["agent.feedback"], undefined);
}

// --- 10. Un scope que otro ya cubre NO se manda a pedir --------------------
// Es la pregunta que el informe dejaba sin responder: que un scope quede sin
// sondear no significa que haga falta. Pedir un permiso innecesario cuesta una
// gestión y no arregla nada.
{
  const cubierto = { "rag.query": { estado: CONFIRMADO } };
  const alt = { "agent.retrieve": ["rag.query"] };
  await comprobar(
    "con la alternativa confirmada, dice que no hace falta", () => /no hace falta pedirlo/.test(comoConseguir("agent.retrieve", { alternativas: alt, scopes: cubierto })),
    true,
  );
  // El control en la dirección contraria: si la alternativa NO está confirmada,
  // no puede decir que no hace falta. Una guarda que tranquiliza de más es peor
  // que la que no dice nada, porque manda a no pedir lo que sí se necesita.
  const sinCubrir = { "rag.query": { estado: AUSENTE } };
  await comprobar(
    "sin la alternativa confirmada, NO tranquiliza", () => /no hace falta pedirlo/.test(comoConseguir("agent.retrieve", { alternativas: alt, scopes: sinCubrir })),
    false,
  );
  await comprobar(
    "y tampoco cuando la alternativa quedó sin sondear", () => /no hace falta pedirlo/.test(
      comoConseguir("agent.retrieve", { alternativas: alt, scopes: { "rag.query": { estado: SIN_SONDEAR } } }),
    ),
    false,
  );
  // Llamarla sin contexto tiene que seguir andando: es la firma que ya existía.
  await comprobar("sin contexto sigue devolviendo una vía", () => Boolean(comoConseguir("agent.retrieve")), true);
}

// --- 11. Las tres causas que comparten status ------------------------------
// Es la razón de ser del comando —«¿por qué me da 403, 402, o un 200 que en
// realidad es un error?»— y hasta acá no la afirmaba nadie.
//
// Se fabrican porque NO se pueden producir: una celda sana no devuelve un 402,
// y pedir un plan sin el módulo agéntico para ver un mensaje es más caro que el
// mensaje. Es el mismo motivo por el que las negativas del bucle se prueban con
// respuestas fabricadas: lo que hay que ver es la clasificación, y para verla
// hay que fabricar la entrada.
//
// El `402` es el caso caro: tres cosas distintas con el mismo status y tres
// remedios que no se parecen —cambiar de plan, cargar saldo, hablar con
// administración—. Confundirlas manda a rotar una key que estaba bien.
const err = (status, opts = {}) => new ApiTransportError(opts.mensaje ?? "x", { status, ...opts });

await comprobar("401 es la credencial, y entonces no se puede afirmar nada de sus scopes", () => clasificar(err(401)).clase, "credencial");
await comprobar("403 es un scope: la key y el plan están bien", () => clasificar(err(403)).clase, "scope");
await comprobar("404 no distingue ausente de ajeno, y lo dice", () => clasificar(err(404)).clase, "no-encontrado");

// Las tres caras del 402.
await comprobar(
  "402 con MODULE_NOT_ENTITLED es el PLAN, no la key", () => clasificar(err(402, { code: "MODULE_NOT_ENTITLED" })).clase,
  "plan",
);
await comprobar(
  "y su detalle dice que pedir scopes no lo arregla", () => clasificar(err(402, { code: "MODULE_NOT_ENTITLED" })).detalle,
  "el plan no incluye el módulo agéntico",
);
await comprobar(
  "402 por saldo es otra cosa: la key y el plan están bien", () => clasificar(err(402, { mensaje: "Insufficient credits for this operation" })).clase,
  "creditos",
);
await comprobar(
  "402 sin más señas es el workspace: suspendido o forzando SSO", () => clasificar(err(402, { mensaje: "Workspace is not operational" })).clase,
  "workspace",
);
// El control en la dirección contraria, que es donde un clasificador se rompe:
// las tres ramas del 402 no pueden colapsar en una. Si `plan` se comiera a
// `creditos`, el informe mandaría a cambiar de plan a quien solo necesita saldo.
await comprobar("y las tres caras del 402 son distintas entre sí", () => new Set([
  clasificar(err(402, { code: "MODULE_NOT_ENTITLED" })).clase,
  clasificar(err(402, { mensaje: "Insufficient credits" })).clase,
  clasificar(err(402, { mensaje: "Workspace suspended" })).clase,
]).size, 3);
// `code` gana sobre el texto, pero el texto solo también alcanza: el servidor no
// siempre manda `code`, y sin este camino un 402 de plan se leería como
// workspace cerrado — que manda a hablar con administración en vez de a mirar el
// plan.
await comprobar(
  "sin `code`, el texto del cuerpo alcanza para reconocer el plan", () => clasificar(err(402, { mensaje: "This module is not enabled for your plan" })).clase,
  "plan",
);
// Y lo que NO es un error de transporte no se disfraza de uno.
await comprobar("un error que no es de transporte se reporta como tal", () => clasificar(new TypeError("boom")).clase, "error");

// Y que la distinción LLEGUE al informe, que es lo que se lee. La clase no
// sirve de nada si las tres salen bajo el mismo título: el remedio de cada una
// se elige mirando esta línea.
{
  const base = { celda: { url: "https://celda.invalid", alcanzable: true }, scopes: {}, alternativas: {}, sondeos: [], avisos: [] };
  const linea = (estado) => formatearInforme({ ...base, credencial: { estado } }).join("\n");
  await comprobar("el informe titula el 402 de plan como plan", () => /no incluye el módulo agéntico/.test(linea("plan")), true);
  await comprobar("y agrega que pedir scopes no lo arregla", () => /pedir más scopes no lo arregla/.test(linea("plan")), true);
  await comprobar("el de workspace manda a otro lado", () => /suspendido, o forzando SSO/.test(linea("workspace")), true);
  await comprobar("y el de plan NO dice lo del workspace", () => /suspendido, o forzando SSO/.test(linea("plan")), false);
  await comprobar("el de créditos no culpa ni a la key ni al plan", () => /la key y los permisos están bien/.test(linea("creditos")), true);
}

// --- 12. `clasificar` lee la causa que el cliente ya calculó -------------
// La lectura del status y del cuerpo vive en `causaDe`, en api-client, y el
// cliente la deja en `err.causa`. Si el texto dijera otra cosa, gana la causa:
// es la única forma de que las dos lecturas no vuelvan a divergir.
await comprobar(
  "con `causa` puesta por el cliente, el texto no manda",
  () => clasificar(err(402, { causa: "creditos", mensaje: "the module says no" })).clase,
  "creditos",
);
await comprobar(
  "la lista blanca de KBs vale como scope para la deducción, con su detalle",
  () => clasificar(err(403, { mensaje: "Knowledge base not allowed" })),
  { clase: "scope", detalle: "la key no tiene acceso a esa knowledge base" },
);
await comprobar("un 429 que sobrevivió al reintento es `error`, no credencial", () => clasificar(err(429)).clase, "error");
await comprobar("y un 500 también", () => clasificar(err(500)).clase, "error");

// --- 13. `diagnosticar` contra un cliente fabricado ------------------------
// Lo que estos casos fijan es la parte del comando que puede mentir sin
// fallar: qué sondeo fija el veredicto de la credencial, y cuáles no.
/**
 * Un cliente REST de mentira. `responder(ruta)` devuelve el cuerpo o lanza.
 * Anota cada petición con cuántas había en vuelo al empezar, que es lo que
 * permite afirmar que las etapas se lanzan juntas.
 */
function clienteFalso(responder) {
  const llamadas = [];
  let enVuelo = 0;
  return {
    baseUrl: "https://celda.invalid",
    rateLimit: null,
    llamadas,
    health: async () => ({ status: 200, data: { ok: true } }),
    request: async (metodo, ruta) => {
      enVuelo++;
      llamadas.push({ ruta, concurrentes: enVuelo });
      await new Promise((r) => setTimeout(r, 2));
      try {
        return { status: 200, data: responder(ruta) };
      } finally {
        enVuelo--;
      }
    },
  };
}
const sano = (ruta) => {
  if (ruta === "/knowledge-bases") return { knowledgeBases: [{ id: "kb1" }] };
  if (/\/articles(\?|$)/.test(ruta)) return { articles: [{ id: "a1" }] };
  return {};
};

// Un 429 en UN sondeo no puede tapar a los otros seis que sí confirmaron.
{
  const client = clienteFalso((ruta) => {
    if (/\/analytics/.test(ruta)) throw err(429, { mensaje: "Rate limit" });
    return sano(ruta);
  });
  const informe = await diagnosticar(client);
  await comprobar("un 429 transitorio NO fija la credencial: sigue siendo ok", informe.credencial.estado, "ok");
  await comprobar("y el informe la titula como válida", () => /la key es válida y tiene permisos/.test(formatearInforme(informe).join("\n")), true);
  await comprobar("el scope del sondeo caído queda SIN SONDEAR, no ausente", informe.scopes["analytics.read"].estado, SIN_SONDEAR);
  await comprobar("con el motivo de que no concluyó", () => /no concluyó/.test(informe.scopes["analytics.read"].motivo), true);
  await comprobar("y un aviso lo dice, para que se vuelva a correr", () => informe.avisos.some((a) => /no concluyeron/.test(a)), true);
  await comprobar("ningún sondeo se saltó por dependencia: el kbId llegó igual", () => informe.sondeos.filter((s) => s.resultado === SIN_SONDEAR).length, 0);
}

// Si TODO falla por transporte, no se puede decir nada de la key — y se dice.
{
  const informe = await diagnosticar(clienteFalso(() => { throw err(503, { mensaje: "upstream" }); }));
  await comprobar("todo caído por transporte es `inconcluso`, no `sin-permisos`", informe.credencial.estado, "inconcluso");
  await comprobar("y el informe lo titula así, sin culpar a la key", () => /no se pudo concluir/.test(formatearInforme(informe).join("\n")), true);
}

// Un 401 sí habla de la credencial entera, y con él se pierde el kbId.
{
  const informe = await diagnosticar(clienteFalso(() => { throw err(401); }));
  await comprobar("un 401 fija la credencial", informe.credencial.estado, "credencial");
  await comprobar("y los sondeos que dependían del kbId quedan sin sondear", () => informe.sondeos.filter((s) => s.resultado === SIN_SONDEAR).length > 0, true);
}

// Las etapas: el primero va solo (da el kbId), los que solo necesitan kbId
// van JUNTOS, y `Get article` espera al que le da el articleId.
{
  const client = clienteFalso(sano);
  const informe = await diagnosticar(client);
  const { llamadas } = client;
  await comprobar("el primer sondeo es List knowledge bases, y va solo", () => [llamadas[0].ruta, llamadas[0].concurrentes], ["/knowledge-bases", 1]);
  await comprobar("los que solo necesitan kbId se lanzan juntos", () => Math.max(...llamadas.map((l) => l.concurrentes)) > 1, true);
  const iArticles = llamadas.findIndex((l) => /\/articles(\?|$)/.test(l.ruta));
  const iArticle = llamadas.findIndex((l) => /\/articles\/a1/.test(l.ruta));
  await comprobar("Get article sale después de List articles, que le da el id", iArticles !== -1 && iArticle > iArticles, true);
  await comprobar("Get article corre solo en su etapa", llamadas[iArticle]?.concurrentes, 1);
  await comprobar("y son siete sondeos, en el orden del catálogo", informe.sondeos.length, 7);
  await comprobar("todos confirmados", () => informe.sondeos.every((s) => s.resultado === CONFIRMADO), true);
  await comprobar("y el informe no arrastra avisos de transporte", () => informe.avisos.filter((a) => /no concluyeron/.test(a)).length, 0);
}

console.log(fallos ? `\n${fallos} fallos` : "\nTodo en verde.");
// `exitCode` y no `exit()`: los temporizadores del cliente falso ya se
// vaciaron, y así el proceso termina cuando el loop se vacía, sin carreras.
process.exitCode = fallos ? 1 : 0;

