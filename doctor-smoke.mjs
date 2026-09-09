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
import { AUSENTE, CONFIRMADO, SIN_SONDEAR, comoConseguir, estadoDeScopes } from "./doctor.mjs";
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

console.log(fallos ? `\n${fallos} fallos` : "\nTodo en verde.");
process.exit(fallos ? 1 : 0);
