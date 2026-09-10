/**
 * Cómo se describe cada clase de error, en un solo lugar.
 *
 * El CLI (`sq-test.mjs`) elige el exit code y el menú (`menu.mjs`) imprime una
 * línea con `✗`, pero la pregunta es la misma —¿qué es esto y qué se muestra?—
 * y estaba contestada en cuatro `catch` distintos que ya se contradecían: dos
 * cadenas del menú discrepaban en el fallthrough (una imprimía el error
 * desconocido, la otra lo relanzaba), y el carril API no pasaba por ninguna,
 * así que un 401 dentro del menú perdía el prefijo de transporte, la cabecera
 * `WWW-Authenticate` y el cuerpo que el CLI sí muestra para el mismo error.
 */

import { McpToolError, McpTransportError } from "./mcp-client.mjs";
import { ApiTransportError } from "./api-client.mjs";
import { SyncError } from "./collection-sync.mjs";
import { ContractError, LlmError } from "./loop.mjs";
import { CatalogError } from "./catalog.mjs";
import { UsageError } from "./commands.mjs";

/** 0 ok · 1 la operación se hizo y el resultado es negativo · 2 uso/config · 3 transporte, auth o rate limit. */
export const EXIT_OK = 0;
export const EXIT_TOOL_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_TRANSPORT = 3;

/**
 * @returns {{ clase: "uso"|"herramienta"|"contrato"|"transporte"|"inesperado", codigo: number, lineas: string[] }}
 *   `lineas` es lo que se muestra: la primera lleva el motivo, las siguientes el
 *   detalle (cabecera de auth, cuerpo). Sin prefijo ni sangría: los pone quien
 *   imprime, que es el único que sabe en qué marco va.
 */
export function describirError(err) {
  if (err instanceof UsageError || err instanceof CatalogError) {
    return { clase: "uso", codigo: EXIT_USAGE, lineas: [err.message] };
  }
  if (err instanceof McpToolError) {
    return { clase: "herramienta", codigo: EXIT_TOOL_ERROR, lineas: [`La herramienta ${err.tool} devolvió un error:`, `  ${err.message}`] };
  }
  if (err instanceof ContractError || err instanceof LlmError) {
    // 1 y no 3: la llamada llegó y contestó 2xx — lo que no se sostuvo fue el
    // cuerpo. No es transporte ni auth, es "la operación se hizo y el resultado
    // es negativo".
    return { clase: "contrato", codigo: EXIT_TOOL_ERROR, lineas: [err.message] };
  }
  if (err instanceof McpTransportError || err instanceof ApiTransportError || err instanceof SyncError) {
    const lineas = [`transporte: ${err.message}`];
    if (err.wwwAuthenticate) lineas.push(`  WWW-Authenticate: ${err.wwwAuthenticate}`);
    if (err.body) lineas.push(`  Respuesta: ${String(err.body).slice(0, 500)}`);
    return { clase: "transporte", codigo: EXIT_TRANSPORT, lineas };
  }
  // Un error que no es de ninguna clase conocida es un bug de programación, y
  // tiene que verse con su stack: taparlo con un mensaje bonito lo esconde.
  return { clase: "inesperado", codigo: EXIT_TRANSPORT, lineas: [String(err?.stack ?? err)] };
}
