#!/usr/bin/env node
/**
 * Ejercita la POLÍTICA y los CONTRATOS del bucle con respuestas fabricadas.
 *
 * Las dos son puras, así que se prueban sin credencial, sin modelo y sin red —
 * y corren en toda la matriz del CI. Es donde vale la pena gastar el esfuerzo:
 * un contrato mal escrito no falla, deja pasar; y una política mal escrita
 * manda una respuesta que nadie evaluó.
 *
 *   node loop-smoke.mjs
 */
import {
  CONTRATO_RETRIEVE,
  CONTRATO_VERIFY,
  ContractError,
  MAX_SEND_RISK,
  decidir,
  esRiesgo,
  exigir,
  riesgoDe,
} from "./loop.mjs";

let fallos = 0;

/**
 * El valor se calcula ACÁ DENTRO, y un throw cuenta como fallo de ESTA
 * afirmación en vez de tumbar la corrida.
 *
 * No es cosmético: al romper `decidir` a propósito para comprobar que el guion
 * lo caza, la rotura hacía crashear el proceso antes de imprimir nada. El exit
 * code seguía siendo el correcto, pero el informe quedaba vacío y no se veía
 * QUÉ había caído — que es justo para lo que existe un guion así.
 */
const comprobar = (titulo, calcular, esperado) => {
  let real;
  try {
    real = typeof calcular === "function" ? calcular() : calcular;
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
const rechaza = (titulo, fn) => {
  try {
    fn();
    fallos++;
    console.error(`✘ ${titulo} — NO rechazó`);
  } catch (err) {
    if (err instanceof ContractError) console.log(`✔ ${titulo}`);
    else {
      fallos++;
      console.error(`✘ ${titulo} — lanzó otra cosa: ${err}`);
    }
  }
};

// --- El número del que sale la decisión -----------------------------------
// Estos dos valores pasan cualquier comprobación laxa y los dos MANDAN una
// respuesta que nadie evaluó. Son la razón de que `esRiesgo` sea un predicado
// y no un `typeof`.
comprobar("false NO es un riesgo (Number(false) === 0 mandaría)", esRiesgo(false), false);
comprobar("-5 NO es un riesgo (-5 <= 0.5 mandaría)", esRiesgo(-5), false);
comprobar("1.5 NO es un riesgo (fuera del rango prometido)", esRiesgo(1.5), false);
comprobar("NaN NO es un riesgo", esRiesgo(NaN), false);
comprobar('"0.2" NO es un riesgo: es una cadena', esRiesgo("0.2"), false);
comprobar("0 sí es un riesgo, y es el mínimo legítimo", esRiesgo(0), true);
comprobar("1 sí es un riesgo, y es el máximo legítimo", esRiesgo(1), true);

// --- De dónde sale el riesgo ----------------------------------------------
comprobar("riskScore directo", () => riesgoDe({ riskScore: 0.3 }), { riesgo: 0.3, via: "riskScore" });
comprobar("confidence se invierte", () => riesgoDe({ confidence: 0.9 }).riesgo.toFixed(2), "0.10");
comprobar("riskScore gana sobre confidence", () => riesgoDe({ riskScore: 0.4, confidence: 0.1 }).via, "riskScore");
// Lo que NO se hace: inventar un tercero. Sin ninguno, no hay riesgo — y
// asumir cero sería mandar algo que nadie evaluó.
comprobar("sin ninguno, no hay riesgo", () => riesgoDe({ verdict: "supported" }), { riesgo: null, via: null });
comprobar("un riskScore inválido no se usa como riesgo", () => riesgoDe({ riskScore: false }), { riesgo: null, via: null });

// --- La política ----------------------------------------------------------
const u = MAX_SEND_RISK;
comprobar("supported con riesgo bajo manda", () => decidir({ verdict: "supported", riesgo: 0.1, umbral: u }).decision, "mandar");
comprobar("supported con riesgo alto escala", () => decidir({ verdict: "supported", riesgo: 0.9, umbral: u }).decision, "escalar");
comprobar("justo en el umbral manda", () => decidir({ verdict: "supported", riesgo: u, umbral: u }).decision, "mandar");
comprobar("unsupported escala aunque el riesgo sea mínimo", () => decidir({ verdict: "unsupported", riesgo: 0, umbral: u }).decision, "escalar");
// `contradicted` escala SIN mirar el riesgo: no es incertidumbre, es un
// desacuerdo entre la KB y lo que el modelo escribió.
comprobar("contradicted escala con riesgo 0", () => decidir({ verdict: "contradicted", riesgo: 0, umbral: u }).decision, "escalar");
comprobar("sin riesgo escala, no manda", () => decidir({ verdict: "supported", riesgo: null, umbral: u }).decision, "escalar");
// Y contradicted gana incluso sobre la falta de riesgo: se mira primero.
comprobar("contradicted sin riesgo sigue escalando", () => decidir({ verdict: "contradicted", riesgo: null, umbral: u }).decision, "escalar");

// --- Contratos: `requires` — la AUSENCIA es el defecto --------------------
rechaza("/retrieve sin chunks", () => exigir({ retrievalId: "r" }, CONTRATO_RETRIEVE, "/retrieve"));
rechaza("/retrieve con chunks que no es array", () => exigir({ chunks: "dos" }, CONTRATO_RETRIEVE, "/retrieve"));
rechaza("/verify sin verdict", () => exigir({ riskScore: 0.1 }, CONTRATO_VERIFY, "/verify"));
rechaza("/verify con un verdict inventado", () => exigir({ verdict: "quizas" }, CONTRATO_VERIFY, "/verify"));
rechaza("una respuesta que no es objeto", () => exigir("texto", CONTRATO_RETRIEVE, "/retrieve"));
rechaza("una respuesta nula", () => exigir(null, CONTRATO_RETRIEVE, "/retrieve"));

// --- Contratos: `accepts` — solo el TIPO es el defecto --------------------
comprobar(
  "un accepts ausente usa su default y no rompe",
  () => exigir({ chunks: [] }, CONTRATO_RETRIEVE, "/retrieve"),
  { chunks: [], retrievalId: null },
);
rechaza("un accepts con el tipo equivocado sí rompe", () => exigir({ chunks: [], retrievalId: 42 }, CONTRATO_RETRIEVE, "/retrieve"));
comprobar(
  "el control en la otra dirección: una respuesta legítima pasa entera",
  () => exigir({ chunks: [{ id: "c1" }], retrievalId: "ret_1" }, CONTRATO_RETRIEVE, "/retrieve"),
  { chunks: [{ id: "c1" }], retrievalId: "ret_1" },
);
comprobar(
  "y la de /verify también",
  () => exigir({ verdict: "supported", evidence: [{ id: "c1" }] }, CONTRATO_VERIFY, "/verify"),
  { verdict: "supported", evidence: [{ id: "c1" }] },
);

console.log(fallos ? `\n${fallos} fallos` : "\nTodo en verde.");
process.exit(fallos ? 1 : 0);
