#!/usr/bin/env node
/**
 * `AGENT_COMMANDS` declara lo mismo que la colección —método, ruta, scopes,
 * `persists`, `spendsCredits`— porque la guarda de `--yes` y el menú leen de
 * ahí para los atajos, y del catálogo para `api run`. Dos fuentes para la misma
 * verdad, y hasta este guion nada comprobaba que dijeran lo mismo: un
 * `spendsCredits` cambiado en la colección hacía que `api run '4. Index
 * status'` pidiera confirmación y `api index-status` no, con el CI en verde.
 *
 * Los topes (20/50) no están en la metadata de la colección, así que no se
 * pueden derivar; lo comparable son estos cinco campos.
 *
 *   node agent-smoke.mjs
 */
import { AGENT_COMMANDS } from "./agent.mjs";
import { cargarCatalogo, fraseDeEfecto } from "./catalog.mjs";

let fallos = 0;
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

const { entradas } = cargarCatalogo();
const MARCA = "KBID-DE-PRUEBA";

/** La ruta de un atajo con la KB marcada, comparable con la de la colección. */
const rutaDe = (spec) => (typeof spec.ruta === "function" ? spec.ruta({ kb: MARCA }) : spec.ruta);

for (const [nombre, spec] of Object.entries(AGENT_COMMANDS)) {
  const ruta = rutaDe(spec);
  const entrada = [...entradas.values()].find((e) => e.metodo === spec.metodo && e.ruta.replace("{{kbId}}", MARCA) === ruta);
  comprobar(`api ${nombre}: la colección declara ${spec.metodo} ${ruta}`, Boolean(entrada), true);
  if (!entrada) continue;
  comprobar(`api ${nombre}: mismos scopes que "${entrada.nombre}"`, () => [...spec.scopes].sort(), [...entrada.scopes].sort());
  comprobar(`api ${nombre}: mismo spendsCredits`, spec.spendsCredits, entrada.spendsCredits);
  // `persists` es prosa en los dos lados; lo que gobierna la guarda es que
  // sea o no sea nulo, y eso es lo que se compara.
  comprobar(`api ${nombre}: mismo persists (escribe o no)`, Boolean(spec.persists), Boolean(entrada.persists));
}

// Y al revés: toda petición agéntica de la colección tiene su atajo. Una
// nueva sin atajo no es un error —`api run` la corre igual—, pero que el
// guion lo diga evita que pase inadvertido.
const agenticas = [...entradas.values()].filter((e) => e.ruta.startsWith("/agent/"));
const cubiertas = new Set(Object.values(AGENT_COMMANDS).map(rutaDe));
comprobar(
  "toda petición /agent/* de la colección tiene atajo",
  () => agenticas.filter((e) => !cubiertas.has(e.ruta.replace("{{kbId}}", MARCA))).map((e) => e.nombre),
  [],
);

// --- Y que la frase de la guarda no se coma el texto de la otra fuente -------
//
// El aviso de `--yes` se armaba como `persiste ${persists}`, y las dos fuentes
// escriben ese campo distinto: acá es un sintagma en castellano pensado para
// encajar detrás de «persiste», y en la colección —que genera la plataforma— es
// una oración en inglés. Interpolarla producía «persiste a DRAFT article … y
// gasta créditos de IA», agramatical, en el único mensaje de la app que decide
// si alguien gasta plata o escribe en la KB de un cliente.
//
// La afirmación es sobre la FORMA, no sobre el texto: la oración se arma sólo
// con palabras nuestras y el campo ajeno va aparte. Así sigue valiendo cuando
// el vendorado cambie ese texto, que es lo que va a pasar.
const conEfecto = [
  ...Object.entries(AGENT_COMMANDS).map(([n, s]) => [`api ${n}`, s]),
  ...[...entradas].map(([n, e]) => [n, e]),
].filter(([, s]) => s.persists || s.spendsCredits);

comprobar(
  "ninguna frase de guarda interpola el texto de `persists`",
  () => conEfecto.filter(([, s]) => s.persists && fraseDeEfecto(s).que.includes(String(s.persists).trim())).map(([n]) => n),
  [],
);

comprobar(
  "y la frase sale sólo de las dos cláusulas nuestras",
  () => [...new Set(conEfecto.map(([, s]) => fraseDeEfecto(s).que))].sort(),
  ["deja algo escrito", "deja algo escrito y gasta créditos de IA", "gasta créditos de IA"],
);

comprobar(
  "lo que `persists` dice se conserva entero, como detalle",
  () => conEfecto.filter(([, s]) => s.persists && fraseDeEfecto(s).detalle !== String(s.persists).trim()).map(([n]) => n),
  [],
);

console.log(fallos ? `\n${fallos} fallos` : "\nTodo en verde.");
process.exitCode = fallos ? 1 : 0;
