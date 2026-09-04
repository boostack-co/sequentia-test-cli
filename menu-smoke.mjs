#!/usr/bin/env node
/**
 * Guiona el menú sin terminal, para poder verificarlo.
 *
 * El menú solo arranca con TTY, y `readline` sobre un pipe lee una línea y se
 * cuelga: sin este driver no hay forma de ejercerlo de punta a punta. Cada
 * argumento es la respuesta a la siguiente pregunta, en orden.
 *
 *   node menu-smoke.mjs 1 1 "" b q          # MCP -> listar KBs -> volver -> salir
 *   node menu-smoke.mjs 1 2 1 "que es X" fast 3 "" "" b q
 *   node menu-smoke.mjs 0 0.4 "" b q        # configuración -> probar conexión
 *
 * OJO: gasta llamadas reales contra el endpoint configurado.
 */

import { correrMenu } from "./menu.mjs";

const guion = process.argv.slice(2);
let i = 0;

const io = {
  question: async (prompt) => {
    // "q" al agotarse el guion: así el menú termina en vez de colgarse.
    const respuesta = i < guion.length ? guion[i++] : "q";
    process.stdout.write(`${prompt}${respuesta}\n`);
    return respuesta;
  },
  close: () => {},
};

process.exitCode = await correrMenu({ io });
