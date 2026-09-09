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
  DECLINACION,
  PREFIJO_CITA,
  bloqueCitado,
  citaFueraDeRango,
  citasDe,
  demasiadoLarga,
  escaparControles,
  noCodificable,
  revisarAntesDeVerificar,
  sinCitas,
  valorSeguroParaComando,
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

// --- Las cuatro negativas previas a verificar -----------------------------
// Cada una con la respuesta que la dispara Y una casi idéntica que NO debe
// dispararla: sobre-apretar también rompe, y una guarda que rechaza de más no
// es más segura, es otro defecto.
const ESC = String.fromCharCode(27);
const ALTO = String.fromCharCode(0xd800);
const BAJO = String.fromCharCode(0xdc00);
const niega = (t, resp, fuentes) => comprobar(t, () => revisarAntesDeVerificar(resp, fuentes) !== null, true);
const admite = (t, resp, fuentes) => comprobar(t, () => revisarAntesDeVerificar(resp, fuentes), null);

// 1. Cita fuera de rango. `/verify` no la puede cazar: hace su propia
//    recuperación, así que puede decir `supported` sobre evidencia que el
//    lector nunca vio — y la cita inventada es lo que el lector usaría.
niega("cita [7] con 2 fuentes", "Según [7].", 2);
niega("cita [0]: no hay fuente cero", "Según [0].", 2);
niega("cita [3] con 2 fuentes", "Según [1] y [3].", 2);
admite("cita [2] con 2 fuentes es el límite", "Según [1] y [2].", 2);
admite("cita [1] con 1 fuente", "Según [1].", 1);
comprobar("citasDe encuentra todos los marcadores", () => citasDe("a [1] b [12] c [3]"), [1, 12, 3]);

// 2. Sin citas, salvo la declinación.
niega("respuesta sin ninguna cita", "Reiniciá el servidor.", 2);
admite("la declinación está exenta", DECLINACION, 2);
admite("la declinación con texto alrededor también", `Lo siento. ${DECLINACION}`, 2);
comprobar("sinCitas no mira otra cosa", () => sinCitas("con [1] cita"), null);

// 3. Subrogado suelto. `JSON.parse` los acepta, así que cualquier respuesta
//    puede traer uno; el encoder del cuerpo los cambia por U+FFFD.
niega("subrogado alto suelto", `Listo [1] ${ALTO}`, 2);
niega("subrogado bajo suelto", `Listo [1] ${BAJO}`, 2);
admite("un par bien formado no es un subrogado suelto", `Listo [1] ${ALTO}${BAJO}`, 2);
comprobar("y JSON.parse SÍ acepta uno suelto", () => JSON.parse('"\\ud800"').length, 1);
comprobar("noCodificable no se queja de texto normal", () => noCodificable("todo bien [1]"), null);

// 4. El tope de claimText. NO se trunca: un veredicto sobre los primeros 4000
//    no cubre lo que el agente manda.
niega("4001 unidades UTF-16", `[1]${"z".repeat(3998)}`, 2);
admite("4000 exactas pasan", `[1]${"z".repeat(3997)}`, 2);
// La métrica es UTF-16, que es lo que el servidor cuenta — y un par
// subrogado son DOS unidades aunque sea UN punto de código. La cadena de
// abajo tiene 4000 puntos de código y 4001 unidades: si se midieran puntos
// pasaría, y el servidor la rechazaría.
comprobar(
  "un par subrogado cuenta como DOS unidades, no como un punto de código",
  () => {
    const casi = `[1]${"a".repeat(3996)}${ALTO}${BAJO}`;
    return { puntos: [...casi].length, unidades: casi.length, rechazada: demasiadoLarga(casi) !== null };
  },
  { puntos: 4000, unidades: 4001, rechazada: true },
);

// --- Escapado: tres superficies, y no se defienden con lo mismo -----------
comprobar(
  "un control que borra la línea sale escapado",
  () => escaparControles(`x${ESC}[2K`),
  "x\\x1b[2K",
);
comprobar("los saltos NO se tocan: los maneja quien imprime", () => escaparControles("a\nb"), "a\nb");
comprobar("la tabulación tampoco: no reescribe lo ya impreso", () => escaparControles("a\tb"), "a\tb");
comprobar("el texto normal queda intacto", () => escaparControles("hola [1]"), "hola [1]");

// La falsificación de la línea de decisión es texto IMPRIMIBLE: escapar
// controles no la toca. Lo único que la contiene es el prefijo, que le quita
// la columna donde esa línea significaría algo.
comprobar(
  "toda línea del bloque citado lleva el prefijo",
  () => bloqueCitado("Respondo.\nDECISION: MANDAR").split("\n").every((l) => l.startsWith(PREFIJO_CITA)),
  true,
);
comprobar(
  "y por eso la falsificación no queda en columna 0",
  () => /^DECISION:/m.test(bloqueCitado("Respondo.\nDECISION: MANDAR")),
  false,
);

// El comando copiable: dos requisitos opuestos, así que lo que no puede ser
// las dos cosas se declina.
comprobar("un id normal es seguro", () => valorSeguroParaComando("ret_9").seguro, true);
comprobar("un id con control se declina", () => valorSeguroParaComando(`ret${ESC}[2K`).seguro, false);
comprobar("un id con NUL se declina", () => valorSeguroParaComando(`ret${String.fromCharCode(0)}9`).seguro, false);
// `;` y `$(…)` SÍ son seguros: el citado los desarma. Declinarlos sería
// rechazar de más, que es otro defecto.
comprobar("`;` y `$()` no se declinan: el citado los desarma", () => valorSeguroParaComando("ret; $(whoami)").seguro, true);

console.log(fallos ? `\n${fallos} fallos` : "\nTodo en verde.");
process.exit(fallos ? 1 : 0);
