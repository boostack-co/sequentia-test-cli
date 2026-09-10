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
import { AUSENTE, CONFIRMADO, SIN_SONDEAR, PROCEDENCIA, alternativasDe, comoConseguir, estadoDeScopes } from "./doctor.mjs";
import { cargarCatalogo } from "./catalog.mjs";

const { entradas } = cargarCatalogo();
let fallos = 0;

function comprobar(titulo, real, esperado) {
  const ok = JSON.stringify(real) === JSON.stringify(esperado);
  if (!ok) {
    fallos++;
    console.error(`✘ ${titulo}\n    esperaba ${JSON.stringify(esperado)}\n    recibí   ${JSON.stringify(real)}`);
  } else {
    console.log(`✔ ${titulo}`);
  }
}

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
  comprobar("nombra el scope que falta y no el confirmado", scopes["agent.index_status"].estado, AUSENTE);
  comprobar("no marca ausente el que sí tiene", scopes["kb.read"].estado, CONFIRMADO);
  comprobar("y no lo declara ambiguo", scopes["agent.index_status"].ambiguo, undefined);
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
  comprobar("con dos candidatos no elige", scopes["agent.index_status"].ambiguo, ["agent.index_status", "kb.read"]);
  comprobar("y lo dice de los dos", scopes["kb.read"].ambiguo, ["agent.index_status", "kb.read"]);
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
  comprobar("un 401 deja el scope sin sondear, no ausente", scopes["kb.read"].estado, SIN_SONDEAR);
  comprobar("y dice que el sondeo no concluyó", scopes["kb.read"].motivo, "el sondeo no concluyó: la key no fue aceptada");
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
  comprobar("propaga el motivo del sondeo saltado", scopes["gaps.read"].motivo, "no se pudo resolver {{kbId}} — dependía de un sondeo anterior");
}

// --- 5. `rag.query` no se atribuye al endpoint que cobra -------------------
// Lo piden la búsqueda léxica (gratuita) y el carril agéntico (que cobra).
// Decir "solo se alcanza por 1. Retrieve" mandaría a mirar donde no es.
{
  const scopes = estadoDeScopes({ entradas, confirmados: new Set(), sondeos: [] });
  const motivo = scopes["rag.query"].motivo ?? "";
  comprobar("rag.query no se atribuye a un endpoint que cobra", /gasta créditos/.test(motivo), false);
  comprobar("agent.retrieve sí, porque no hay petición gratuita que lo ejercite", /gasta créditos/.test(scopes["agent.retrieve"].motivo ?? ""), true);
}

// --- 6. Nunca se afirma "ausente" de algo que no se sondeó -----------------
{
  const scopes = estadoDeScopes({ entradas, confirmados: new Set(), sondeos: [] });
  const ausentes = Object.entries(scopes).filter(([, v]) => v.estado === AUSENTE);
  comprobar("sin sondeos no hay ningún scope ausente", ausentes.length, 0);
}

// --- 7. Todo scope declarado sabe decir dónde se consigue ------------------
{
  const scopes = estadoDeScopes({ entradas, confirmados: new Set(), sondeos: [] });
  const mudos = Object.keys(scopes).filter((s) => !comoConseguir(s));
  comprobar("ningún scope se queda sin vía", mudos, []);
}

// --- 8. Un consejo tiene que poder ejecutarse -----------------------------
// La versión anterior mandaba a "pedirlo por la vía interna", y esa vía no
// existe. El daño de un consejo así no es que sea inútil: es que PARECE
// ejecutable, así que manda a esperar una gestión en vez de a preguntar. Se
// afirma por texto porque lo que se rompió fue exactamente el texto.
{
  const scopes = estadoDeScopes({ entradas, confirmados: new Set(), sondeos: [] });
  const conViaInexistente = Object.keys(scopes).filter((s) => /vía interna/i.test(comoConseguir(s)));
  comprobar("ningún scope manda a una vía que no existe", conViaInexistente, []);
  comprobar(
    "y el que no está en ningún formulario nombra la vía que sí existe",
    /API de creación de keys/.test(PROCEDENCIA["gaps.read"]),
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
  comprobar("`/agent/retrieve` declara rag.query como alternativa", alt["agent.retrieve"], ["rag.query"]);
  comprobar("y la relación es simétrica", alt["rag.query"].includes("agent.retrieve"), true);
  comprobar("`/agent/gap-report` declara gaps.write", alt["agent.gap_report"], ["gaps.write"]);
  // `agent.feedback` es el único endpoint agéntico SIN alternativa: el servidor
  // no le declara fallback. Que no aparezca acá no es un olvido — es la razón
  // por la que ese scope sí hay que conseguirlo.
  comprobar("`/agent/feedback` no tiene alternativa, y por eso no figura", alt["agent.feedback"], undefined);
}

// --- 10. Un scope que otro ya cubre NO se manda a pedir --------------------
// Es la pregunta que el informe dejaba sin responder: que un scope quede sin
// sondear no significa que haga falta. Pedir un permiso innecesario cuesta una
// gestión y no arregla nada.
{
  const cubierto = { "rag.query": { estado: CONFIRMADO } };
  const alt = { "agent.retrieve": ["rag.query"] };
  comprobar(
    "con la alternativa confirmada, dice que no hace falta",
    /no hace falta pedirlo/.test(comoConseguir("agent.retrieve", { alternativas: alt, scopes: cubierto })),
    true,
  );
  // El control en la dirección contraria: si la alternativa NO está confirmada,
  // no puede decir que no hace falta. Una guarda que tranquiliza de más es peor
  // que la que no dice nada, porque manda a no pedir lo que sí se necesita.
  const sinCubrir = { "rag.query": { estado: AUSENTE } };
  comprobar(
    "sin la alternativa confirmada, NO tranquiliza",
    /no hace falta pedirlo/.test(comoConseguir("agent.retrieve", { alternativas: alt, scopes: sinCubrir })),
    false,
  );
  comprobar(
    "y tampoco cuando la alternativa quedó sin sondear",
    /no hace falta pedirlo/.test(
      comoConseguir("agent.retrieve", { alternativas: alt, scopes: { "rag.query": { estado: SIN_SONDEAR } } }),
    ),
    false,
  );
  // Llamarla sin contexto tiene que seguir andando: es la firma que ya existía.
  comprobar("sin contexto sigue devolviendo una vía", Boolean(comoConseguir("agent.retrieve")), true);
}

console.log(fallos ? `\n${fallos} fallos` : "\nTodo en verde.");
process.exit(fallos ? 1 : 0);
