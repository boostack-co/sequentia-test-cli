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
import { cargarCatalogo } from "./catalog.mjs";

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

console.log(fallos ? `\n${fallos} fallos` : "\nTodo en verde.");
process.exitCode = fallos ? 1 : 0;
