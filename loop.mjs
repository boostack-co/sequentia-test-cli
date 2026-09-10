/**
 * El bucle gobernado: **recuperar → generar con tu modelo → verificar → decidir**.
 *
 * No es un tutorial del flujo, que es obvio. Es el flujo con las decisiones
 * difíciles tomadas y explicadas, y lo que enseña es **dónde está la frontera
 * de responsabilidad**: Sequentia recupera y verifica; el modelo y la decisión
 * son tuyos.
 *
 * Sin framework de agentes, y no por ascetismo: un framework resuelve selección
 * no determinista de herramientas, y este bucle es lineal y fijo — no habría
 * nada que orquestar. Lo caro de acá —los contratos de respuesta, la política
 * de riesgo, la traza auditable— ningún framework lo trae, y un framework lo
 * esconde.
 */

// El tope de `claimText` sale de `agent.mjs`, que es donde vive el contrato
// del carril agéntico. Repetirlo acá daría dos fuentes para el mismo número,
// y la que quedara vieja dejaría pasar lo que el servidor rechaza.
import { VERIFY_CLAIM_MAX } from "./agent.mjs";
import { UsageError, loadDotenv } from "./commands.mjs";
import { describirFalloFetch } from "./http-comun.mjs";

/** La única cifra de política. Todo lo demás se deriva de la respuesta. */
export const MAX_SEND_RISK = 0.5;

/** Tope del carril gestionado. Distinto del de `/retrieve`, que es 50. */
export const MANAGED_MAX_RESULTS = 20;

/** Los veredictos que `/agent/verify` promete. */
export const VEREDICTOS = ["supported", "unsupported", "contradicted"];

export class ContractError extends Error {}
export class LlmError extends Error {}

// ---------------------------------------------------------------------------
// Contratos de respuesta
// ---------------------------------------------------------------------------
/**
 * La distinción entre `requires` y `accepts` **es** el diseño, no un detalle.
 *
 * - **`requires`** — el campo cuya AUSENCIA hace que el default del llamante
 *   engañe. Si `chunks` falta y se lo trata como `[]`, la corrida entra en la
 *   rama de sin-evidencia, y esa rama archiva un hueco durable culpando a un
 *   curador por una pregunta que la KB quizá cubre. **La ausencia es el
 *   defecto**, así que un `requires` que falta corta la corrida.
 *
 * - **`accepts`** — el campo cuyo default es inocuo pero cuyo TIPO equivocado
 *   revienta, y revienta *después* de haber registrado el paso como exitoso.
 *   **Solo el tipo es el defecto**: ausente se usa el default y no pasa nada.
 *
 * Se declaran en el sitio de la llamada y no en un registro central, porque
 * solo quien llama sabe qué campos lee. Nombrarlos acá es lo que hace visible
 * en un review qué necesita un endpoint nuevo.
 */
export function exigir(cuerpo, contrato, etiqueta) {
  const salida = {};
  if (cuerpo === null || typeof cuerpo !== "object") {
    throw new ContractError(`${etiqueta} no devolvió un objeto. Recibí: ${JSON.stringify(cuerpo)?.slice(0, 120)}`);
  }

  for (const [campo, { valido, porque }] of Object.entries(contrato.requires ?? {})) {
    const v = cuerpo[campo];
    if (v === undefined || v === null) {
      throw new ContractError(`${etiqueta} no trae "${campo}".\n  ${porque}`);
    }
    if (!valido(v)) {
      throw new ContractError(`${etiqueta} trae "${campo}" con un valor que no sirve: ${JSON.stringify(v)}.\n  ${porque}`);
    }
    salida[campo] = v;
  }

  for (const [campo, { valido, porDefecto }] of Object.entries(contrato.accepts ?? {})) {
    const v = cuerpo[campo];
    if (v === undefined || v === null) {
      salida[campo] = porDefecto;
      continue;
    }
    if (!valido(v)) {
      // Ausente estaría bien; con el tipo equivocado, no. Reventaría más tarde
      // y con el paso ya anotado como exitoso, que es peor que fallar acá.
      throw new ContractError(`${etiqueta} trae "${campo}" con el tipo equivocado: ${JSON.stringify(v)}`);
    }
    salida[campo] = v;
  }
  return salida;
}

/**
 * **Un tipo no basta cuando de un número se toma una decisión.**
 *
 *   riskScore: false  ->  Number(false) === 0  ->  riesgo mínimo  ->  MANDAR
 *   riskScore: -5     ->  -5 <= 0.5            ->                     MANDAR
 *
 * Las dos pasan cualquier comprobación laxa y las dos mandan una respuesta que
 * nadie evaluó. Se cierra con un predicado: número real, finito, y dentro del
 * rango que el servidor promete.
 */
export const esRiesgo = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

export const CONTRATO_RETRIEVE = {
  requires: {
    chunks: {
      valido: Array.isArray,
      porque:
        "sin `chunks` la recuperación se leería como vacía, que es la rama de sin-evidencia — y esa rama\n" +
        "  archiva un hueco durable, culpando a un curador por una pregunta que la KB quizá cubre.",
    },
  },
  accepts: {
    retrievalId: { valido: (v) => typeof v === "string" && v !== "", porDefecto: null },
  },
};

export const CONTRATO_VERIFY = {
  requires: {
    verdict: {
      valido: (v) => VEREDICTOS.includes(v),
      porque: `sin un veredicto de ${VEREDICTOS.join("/")} se escalaría por una razón que nadie dio.`,
    },
  },
  accepts: {
    evidence: { valido: Array.isArray, porDefecto: [] },
  },
};

export const CONTRATO_QUERY = {
  requires: {
    answer: {
      valido: (v) => typeof v === "string",
      porque: "el carril gestionado existe para devolver una respuesta; sin ella no hay nada que contrastar.",
    },
  },
};

/**
 * El riesgo de la respuesta, en [0, 1].
 *
 * El servidor lo puede expresar de dos formas y hay que aceptar las dos. Lo que
 * **no** se hace es inventar una tercera: si no viene ninguna, el bucle escala
 * y dice por qué, en vez de asumir riesgo cero — que es exactamente la
 * suposición que haría mandar una respuesta que nadie evaluó.
 */
export function riesgoDe(cuerpo) {
  if (esRiesgo(cuerpo?.riskScore)) return { riesgo: cuerpo.riskScore, via: "riskScore" };
  if (esRiesgo(cuerpo?.confidence)) return { riesgo: 1 - cuerpo.confidence, via: "1 - confidence" };
  return { riesgo: null, via: null };
}

// ---------------------------------------------------------------------------
// La política: una sola cifra
// ---------------------------------------------------------------------------
/**
 * Decide. Todo lo que no sea el umbral sale de la respuesta del servidor.
 *
 * @returns {{decision: "mandar"|"escalar", motivo: string}}
 */
export function decidir({ verdict, riesgo, umbral }) {
  if (verdict === "contradicted") {
    // Escala siempre, sin mirar el riesgo: que la KB contradiga lo que el
    // modelo escribió no es incertidumbre, es un desacuerdo.
    return { decision: "escalar", motivo: "la KB CONTRADICE la respuesta — no es incertidumbre, es un desacuerdo" };
  }
  if (riesgo === null) {
    return {
      decision: "escalar",
      motivo: "la verificación no trajo ni `riskScore` ni `confidence`: no hay con qué decidir, y asumir riesgo cero mandaría algo que nadie evaluó",
    };
  }
  if (verdict === "unsupported") {
    return { decision: "escalar", motivo: "la KB no respalda la respuesta: no la contradice, pero tampoco la sostiene" };
  }
  if (riesgo > umbral) {
    return { decision: "escalar", motivo: `riesgo ${riesgo.toFixed(2)} por encima del umbral ${umbral}` };
  }
  return { decision: "mandar", motivo: `respaldada por la KB, riesgo ${riesgo.toFixed(2)} <= ${umbral}` };
}

// ---------------------------------------------------------------------------
// El modelo del cliente
// ---------------------------------------------------------------------------
export const LLM_URL_KEY = "SQ_TEST_LLM_URL";
export const LLM_KEY_KEY = "SQ_TEST_LLM_KEY";
export const LLM_MODEL_KEY = "SQ_TEST_LLM_MODEL";

/**
 * La config del modelo. **Es tuyo**: este CLI no trae ninguno ni sabe cuál usás.
 *
 * El shape es el `/chat/completions` de OpenAI, que cubre vLLM, Ollama, LM
 * Studio, OpenRouter y OpenAI directo. **Azure queda afuera a propósito**:
 * necesita `endpoint`, `apiVersion` y `deployment` en la URL, que este shape
 * genérico no monta, y fingir que anda sería peor que decir que no está.
 */
export function resolveLlmConfig(flags = {}) {
  const { values: dotenv } = loadDotenv();
  const pick = (k) => process.env[k] ?? dotenv[k];
  const url = flags["llm-url"] ?? pick(LLM_URL_KEY);
  const model = flags["llm-model"] ?? pick(LLM_MODEL_KEY);
  if (!url) {
    throw new UsageError(
      `Falta ${LLM_URL_KEY}: el endpoint de TU modelo.\n` +
        "  Tiene que ser un /chat/completions compatible con OpenAI — vLLM, Ollama,\n" +
        "  LM Studio, OpenRouter u OpenAI directo sirven tal cual.\n" +
        `  Ejemplo:  ${LLM_URL_KEY}=http://localhost:11434/v1/chat/completions\n` +
        "  Azure NO entra en este shape: necesita endpoint, apiVersion y deployment.\n" +
        "  Para ver el bucle sin modelo:  api loop --no-generate",
    );
  }
  if (!model) throw new UsageError(`Falta ${LLM_MODEL_KEY}: el nombre del modelo a pedir.`);
  // La key es opcional a propósito: un Ollama local no pide ninguna.
  return { url, model, key: flags["llm-key"] ?? pick(LLM_KEY_KEY) ?? null };
}

/**
 * ¿El servidor rechazó la petición **por** `temperature`, y no por otra cosa?
 *
 * Se pide `400` Y que el mensaje nombre el parámetro. Las dos condiciones, no
 * una: un `400` a secas puede ser un modelo que no existe o un cuerpo mal
 * formado, y reintentar eso sin `temperature` gastaría una segunda llamada para
 * volver a fallar igual, tapando el error real detrás de un síntoma inventado.
 */
export function rechazaTemperature(status, texto) {
  return status === 400 && /temperature/i.test(String(texto));
}

/** Un POST al modelo. Separado para poder repetirlo con otro cuerpo. */
async function postearAlModelo(url, headers, cuerpo, timeoutMs) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new LlmError(`No se pudo contactar tu modelo en ${url}: ${describirFalloFetch(err, timeoutMs)}`);
  }
  return { res, texto: await res.text() };
}

/**
 * Una respuesta del modelo del cliente. Sin dependencias: `fetch` y nada más.
 *
 * Devuelve `{ contenido, temperatura }`. La `temperatura` no es decoración: es
 * lo que dice si la corrida se puede repetir, y eso va a la traza.
 *
 * `temperature: 0` se pide a propósito — el bucle decide sobre lo que el modelo
 * escribió, y una corrida que no se puede repetir no se puede auditar. Pero los
 * modelos de razonamiento lo **rechazan** con un `400` ("Only the default (1)
 * value is supported"): la familia `o*` de OpenAI, y desde `gpt-5.5` también la
 * principal. Exigirlo dejaría afuera a lo más nuevo del proveedor más común, y
 * sin ningún workaround: no hay flag ni variable que pise el valor.
 *
 * Así que se reintenta UNA vez sin el parámetro, y el precio se **anota**. Este
 * módulo no imprime; lo que no llega a la traza no existe para quien audita, y
 * degradar el determinismo en silencio sería el mismo fallo callado que el CLI
 * rechaza en todas partes.
 */
export async function generar({ url, model, key }, mensajes, { timeoutMs = 120000, onDebug } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (onDebug) onDebug(`generando con ${model} en ${url}`);

  let temperatura = 0;
  let { res, texto } = await postearAlModelo(url, headers, { model, messages: mensajes, temperature: 0 }, timeoutMs);

  if (rechazaTemperature(res.status, texto)) {
    temperatura = null;
    if (onDebug) onDebug(`${model} rechaza temperature:0 — reintento sin el parámetro; la corrida deja de ser reproducible`);
    ({ res, texto } = await postearAlModelo(url, headers, { model, messages: mensajes }, timeoutMs));
  }

  if (!res.ok) throw new LlmError(`Tu modelo respondió ${res.status}: ${texto.slice(0, 300)}`);

  let cuerpo;
  try {
    cuerpo = JSON.parse(texto);
  } catch {
    throw new LlmError(`Tu modelo no devolvió JSON. Recibí: ${texto.slice(0, 200)}`);
  }
  const contenido = cuerpo?.choices?.[0]?.message?.content;
  if (typeof contenido !== "string" || contenido.trim() === "") {
    // Mismo criterio que los contratos de arriba: un default acá —cadena
    // vacía— seguiría hasta `/verify`, que juzgaría la nada y devolvería algo.
    throw new LlmError(
      "Tu modelo no devolvió `choices[0].message.content` como texto.\n" +
        `  Recibí: ${JSON.stringify(cuerpo)?.slice(0, 200)}`,
    );
  }
  return { contenido, temperatura };
}

/** El prompt. Corto a propósito: lo que se enseña es el reparto, no el prompt. */
export function armarMensajes(pregunta, chunks) {
  const evidencia = chunks
    .map((c, i) => `[${i + 1}] ${typeof c === "string" ? c : (c?.content ?? c?.text ?? JSON.stringify(c))}`)
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "Respondé ÚNICAMENTE con la evidencia numerada que se te da. " +
        "Citá cada afirmación con su marcador [n]. " +
        "Si la evidencia no alcanza, decí exactamente: NO_HAY_EVIDENCIA_SUFICIENTE.",
    },
    { role: "user", content: `Pregunta: ${pregunta}\n\nEvidencia:\n${evidencia}` },
  ];
}

/** Lo que el prompt pide decir cuando la evidencia no alcanza. */
export const DECLINACION = "NO_HAY_EVIDENCIA_SUFICIENTE";

// ---------------------------------------------------------------------------
// El bucle
// ---------------------------------------------------------------------------
/**
 * Corre el ciclo y devuelve la **traza**: un array de pasos.
 *
 * Es un array y no un objeto porque bajo `--json` la traza es lo que se emite,
 * y el tipo no puede cambiar con el desenlace — una corrida que decide y una
 * que muere temprano tienen que producir la misma forma, o quien la parsea
 * escribe dos caminos y prueba uno.
 *
 * No lanza por una decisión: escalar es un resultado, no un error. Sí propaga
 * los fallos de llamada, que son otra cosa.
 */
export async function correrBucle({ client, pregunta, kb, opciones, onPaso = () => {}, traza = [] }) {
  const { umbral, generarRespuesta, gestionado, maxResults } = opciones;
  // La traza la puede aportar el llamante, y bajo `--json` **tiene** que
  // hacerlo: si el bucle lanza a mitad de camino, lo anotado hasta ahí es lo
  // único que explica dónde murió. Devolverla solo al terminar bien dejaría
  // esa salida sin documento, y cero bytes es indistinguible de un proceso
  // que se murió.
  const anotar = (paso) => {
    traza.push(paso);
    onPaso(paso);
    return paso;
  };

  // --- 1. Recuperar --------------------------------------------------------
  const t1 = performance.now();
  const r1 = await client.request("POST", "/agent/retrieve", {
    body: { query: pregunta, knowledgeBaseId: kb, ...(maxResults ? { maxResults } : {}) },
  });
  const rec = exigir(r1.data, CONTRATO_RETRIEVE, "/agent/retrieve");
  anotar({
    paso: "recuperar",
    ok: true,
    ms: Math.round(performance.now() - t1),
    fragmentos: rec.chunks.length,
    retrievalId: rec.retrievalId,
  });

  if (rec.chunks.length === 0) {
    // Sin evidencia no hay nada que generar ni que verificar. **No se archiva
    // ningún hueco acá**: eso es una escritura, y este comando no escribe.
    anotar({
      paso: "decidir",
      ok: true,
      decision: "escalar",
      motivo: "la recuperación no trajo ningún fragmento: no hay con qué responder",
    });
    return traza;
  }

  if (!generarRespuesta) {
    // `--no-generate`: se para acá. Sirve para mirar scopes y procedencia sin
    // modelo y sin gastar nada más.
    anotar({ paso: "decidir", ok: true, decision: "no-decidido", motivo: "--no-generate: se paró tras recuperar" });
    return traza;
  }

  // --- 2. Generar, con TU modelo -------------------------------------------
  // La config del modelo YA está resuelta: se comprueba antes de la primera
  // llamada, porque `/agent/retrieve` gasta créditos y una corrida que no puede
  // terminar no debería gastarlos primero para después decir que falta una
  // variable de entorno.
  const llm = opciones.llm;
  const t2 = performance.now();
  const { contenido: crudo, temperatura } = await generar(llm, armarMensajes(pregunta, rec.chunks), { onDebug: opciones.onDebug });
  // Se recorta ACA, una sola vez, y lo recortado es lo que se mide y lo que se
  // manda. Medir una cosa y enviar otra es la trampa del tope de `claimText`.
  const respuesta = crudo.trim();
  anotar({
    paso: "generar",
    ok: true,
    ms: Math.round(performance.now() - t2),
    modelo: llm.model,
    // `null` = el modelo rechazó `temperature:0` y la corrida NO es repetible.
    temperatura,
    caracteres: respuesta.length,
    declino: respuesta.includes(DECLINACION),
    respuesta,
  });

  if (respuesta.includes(DECLINACION)) {
    // El modelo dijo que no le alcanza. Verificar eso no tiene sentido: el
    // veredicto sería sobre la declinación, no sobre una afirmación.
    anotar({
      paso: "decidir",
      ok: true,
      decision: "escalar",
      motivo: "el modelo declinó por evidencia insuficiente; no hay afirmación que verificar",
    });
    return traza;
  }

  // --- 2b. Las cuatro negativas, ANTES de verificar -------------------------
  // Mandar cualquiera de estas a `/verify` produce un veredicto que no habla de
  // lo que el agente va a enviar. Y ninguna archiva un hueco de conocimiento:
  // la KB no tiene la culpa de que el modelo invente una cita.
  const negativa = revisarAntesDeVerificar(respuesta, rec.chunks.length);
  if (negativa) {
    anotar({
      paso: "decidir",
      ok: true,
      decision: "escalar",
      motivo: negativa,
      culpa: "modelo",
    });
    return traza;
  }

  // --- 3. Verificar, con Sequentia -----------------------------------------
  const t3 = performance.now();
  const r3 = await client.request("POST", "/agent/verify", {
    body: { claimText: respuesta, knowledgeBaseId: kb },
  });
  const ver = exigir(r3.data, CONTRATO_VERIFY, "/agent/verify");
  const { riesgo, via } = riesgoDe(r3.data);
  anotar({
    paso: "verificar",
    ok: true,
    ms: Math.round(performance.now() - t3),
    verdict: ver.verdict,
    riesgo,
    riesgoVia: via,
    evidencia: ver.evidence,
  });

  // --- 4. Contraste opcional con el carril gestionado ----------------------
  if (gestionado) {
    const t4 = performance.now();
    const r4 = await client.request("POST", "/agent/query", {
      body: { query: pregunta, knowledgeBaseIds: [kb], ...(maxResults ? { options: { maxResults } } : {}) },
    });
    const q = exigir(r4.data, CONTRATO_QUERY, "/agent/query");
    anotar({
      paso: "contrastar",
      ok: true,
      ms: Math.round(performance.now() - t4),
      caracteres: q.answer.length,
      respuesta: q.answer,
    });
  }

  // --- 5. Decidir ----------------------------------------------------------
  const { decision, motivo } = decidir({ verdict: ver.verdict, riesgo, umbral });
  anotar({ paso: "decidir", ok: true, decision, motivo, umbral });
  return traza;
}

/** La decisión de una traza, o null si nunca llegó a decidir. */
export function decisionDe(traza) {
  return traza.findLast?.((p) => p.paso === "decidir")?.decision ?? null;
}

// ---------------------------------------------------------------------------
// Presentación
// ---------------------------------------------------------------------------
/**
 * La narración de un paso, para stderr.
 *
 * La respuesta del modelo se imprime como **bloque citado**: viene de fuera, y
 * el prefijo es lo único que le quita la columna donde una línea suya podría
 * significar «esto lo dijo el bucle».
 */
export function narrar(paso, { mostrarEvidencia = false, mostrarRespuesta = false } = {}) {
  switch (paso.paso) {
    case "recuperar":
      return `· recuperar   ${paso.fragmentos} fragmentos · ${paso.ms} ms${paso.retrievalId ? ` · id ${paso.retrievalId}` : ""}`;
    case "generar": {
      const temp = paso.temperatura === null ? " · SIN temperature:0, no reproducible" : "";
      const cabecera = `· generar     ${paso.caracteres} caracteres con ${paso.modelo} · ${paso.ms} ms${temp}${paso.declino ? " · DECLINÓ" : ""}`;
      return mostrarRespuesta ? `${cabecera}\n${bloqueCitado(paso.respuesta)}` : cabecera;
    }
    case "verificar": {
      const r = paso.riesgo === null ? "sin riesgo declarado" : `riesgo ${paso.riesgo.toFixed(2)} (${paso.riesgoVia})`;
      const n = paso.evidencia.length;
      const ev = mostrarEvidencia ? ` · ${n} pieza${n === 1 ? "" : "s"} de evidencia` : "";
      return `· verificar   ${paso.verdict} · ${r} · ${paso.ms} ms${ev}`;
    }
    case "contrastar":
      return `· contrastar  el carril gestionado devolvió ${paso.caracteres} caracteres · ${paso.ms} ms`;
    case "decidir": {
      // El motivo puede traer texto del modelo (los marcadores que citó, por
      // ejemplo). Se escapa acá, en el límite de la impresión, y no donde se
      // arma el mensaje: los mensajes se componen en muchos lugares y solo este
      // sabe que lo que sigue va a una terminal.
      const culpa = paso.culpa === "modelo" ? "  (es del modelo, no de la KB: no se archiva ningún hueco)\n" : "";
      return `\nDECISION: ${paso.decision.toUpperCase()}\n${culpa}  ${escaparControles(paso.motivo)}`;
    }
    default:
      return `· ${paso.paso}`;
  }
}

// ---------------------------------------------------------------------------
// Las cuatro negativas previas a verificar
// ---------------------------------------------------------------------------
/**
 * Hay respuestas que **no son verificables**, y mandarlas a `/verify` produce
 * un veredicto que no habla de lo que el agente va a enviar.
 *
 * Ninguna de las cuatro archiva un hueco de conocimiento, y eso es deliberado:
 * **la KB no tiene la culpa de que el modelo invente una cita.** Archivar un
 * hueco acá mandaría a un curador a escribir un artículo sobre una pregunta
 * que la KB quizá ya cubre.
 */

/** Los marcadores `[n]` que la respuesta usa, en orden de aparición. */
export function citasDe(texto) {
  return [...String(texto).matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
}

/**
 * 1. Un `[7]` cuando nunca se le dieron siete fuentes.
 *
 * `/verify` **no lo puede cazar**: hace su propia recuperación y juzga la
 * afirmación, así que puede devolver `supported` sobre evidencia que el lector
 * nunca vio. La cita inventada es justamente lo que el lector usaría para
 * comprobarla.
 */
export function citaFueraDeRango(respuesta, fuentes) {
  const malas = citasDe(respuesta).filter((n) => n < 1 || n > fuentes);
  if (!malas.length) return null;
  return (
    `el modelo citó ${malas.map((n) => `[${n}]`).join(", ")} y solo se le dieron ${fuentes} fuente(s).\n` +
    "  /verify no lo cazaría: hace su propia recuperación y juzga la afirmación, así que\n" +
    "  puede devolver `supported` sobre evidencia que el lector nunca vio."
  );
}

/**
 * 2. Ninguna cita, y tampoco la declinación explícita.
 *
 * Es política visible hacia afuera —una respuesta sin procedencia no se manda—
 * y no una exigencia de formato: por eso la declinación, que tampoco trae
 * citas, está exenta.
 */
export function sinCitas(respuesta) {
  if (respuesta.includes(DECLINACION)) return null;
  if (citasDe(respuesta).length) return null;
  return (
    "el modelo no citó ninguna fuente y tampoco declinó.\n" +
    "  Una respuesta sin procedencia no se puede comprobar, y mandarla igual convierte\n" +
    "  al verificador en un sello de goma."
  );
}

/**
 * 3. Un subrogado suelto.
 *
 * `JSON.parse` los acepta, así que **cualquier** respuesta puede traer uno; el
 * encoder que arma el cuerpo de `/verify` los reemplaza por U+FFFD.
 * Sustituirlo sería pedirle a `/verify` un veredicto sobre una afirmación que
 * el modelo nunca hizo.
 */
export function noCodificable(respuesta) {
  // Un alto sin su bajo detrás, o un bajo sin su alto delante.
  const suelto = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  if (!suelto.test(respuesta)) return null;
  return (
    "la respuesta trae un subrogado suelto y no se puede codificar como UTF-8.\n" +
    "  El encoder del cuerpo lo reemplazaría por U+FFFD, así que /verify juzgaría una\n" +
    "  afirmación que el modelo nunca hizo."
  );
}

/**
 * 4. Por encima del tope de `claimText`.
 *
 * **No se trunca**: un veredicto sobre los primeros 4000 caracteres no cubre lo
 * que el agente manda.
 *
 * Se mide **exactamente lo que se envía**, que es el texto ya recortado por
 * `String.prototype.trim`. Medir una cosa y mandar otra es la trampa acá: las
 * definiciones de «espacio en blanco» no coinciden entre runtimes, y la
 * diferencia son unos pocos caracteres — suficientes para dejar pasar una
 * afirmación que el servidor habría rechazado. Recortando y midiendo con la
 * misma operación, lo medido y lo enviado son el mismo string por construcción.
 */
export function demasiadoLarga(respuesta) {
  const n = respuesta.length;
  if (n <= VERIFY_CLAIM_MAX) return null;
  return (
    `la respuesta tiene ${n} unidades UTF-16 y /verify acepta ${VERIFY_CLAIM_MAX}.\n` +
    "  No se trunca a propósito: un veredicto sobre los primeros 4000 caracteres no cubre\n" +
    "  lo que el agente termina mandando."
  );
}

/**
 * Corre las cuatro. Devuelve el motivo de la primera que dispare, o `null`.
 *
 * @param {string} respuesta ya recortada — la misma que se va a enviar
 * @param {number} fuentes cuántos fragmentos se le dieron al modelo
 */
export function revisarAntesDeVerificar(respuesta, fuentes) {
  for (const revisar of [
    () => demasiadoLarga(respuesta),
    () => noCodificable(respuesta),
    () => citaFueraDeRango(respuesta, fuentes),
    () => sinCitas(respuesta),
  ]) {
    const motivo = revisar();
    if (motivo) return motivo;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Escapado de lo que llega a la terminal
// ---------------------------------------------------------------------------
/**
 * Tres superficies distintas, y **no se defienden con lo mismo**. Confundirlas
 * es lo que deja un agujero: escapar controles no impide una falsificación
 * hecha de texto imprimible, y un prefijo de bloque no vuelve seguro un comando.
 */

/**
 * C0 y C1, que es lo que una terminal puede llegar a interpretar.
 *
 * El salto de línea queda FUERA a propósito: los saltos los maneja quien
 * imprime, que es el único que sabe cuáles son suyos. La tabulación también
 * queda fuera — no mueve el cursor a otra línea, así que no puede reescribir
 * lo ya impreso.
 */
const CONTROLES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * 1. Caracteres de control, porque una terminal **actúa** sobre algunos.
 *
 * La secuencia `ESC [ 2 K` borra la línea entera: metida en un fragmento de la
 * KB, puede borrar la línea de escalado y dejar en su lugar un
 * `DECISION: MANDAR` falso. Se escapan a su forma visible en vez de quitarse,
 * para que se vea que estaban.
 */
export function escaparControles(texto) {
  return String(texto).replace(CONTROLES, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));
}

/** El prefijo de cita. Marca la columna que significa «esto NO lo dijo el bucle». */
export const PREFIJO_CITA = "  | ";

/**
 * 2. La respuesta del modelo, como bloque citado.
 *
 * Los saltos de línea solo se pueden defender donde el código sabe cuáles son
 * suyos. Cada byte de una falsificación —una línea que diga `DECISION: MANDAR`—
 * es texto imprimible corriente, así que **escapar controles no la toca**: hace
 * falta el prefijo, que le quita la columna donde esa línea significaría algo.
 */
export function bloqueCitado(texto, prefijo = PREFIJO_CITA) {
  return escaparControles(texto)
    .split("\n")
    .map((linea) => prefijo + linea)
    .join("\n");
}

/**
 * 3. El comando copiable, que tiene **dos requisitos en direcciones opuestas**.
 *
 * Seguro de **ejecutar**: hay que citar, porque `;` y `$(...)` son texto
 * imprimible y el citado es lo único que los desarma.
 *
 * Seguro de **copiar**: un carácter de control sobrevive al citado —las
 * comillas no lo neutralizan, solo lo envuelven— y después hay que escaparlo
 * para imprimirlo, con lo que el comando pegado llevaría un id **distinto** del
 * real. Y no escaparlo es peor: la terminal lo interpreta al pegarlo.
 *
 * No hay orden de las dos operaciones que arregle las dos cosas, así que un
 * valor que no puede ser ambas **se declina**: se imprime un placeholder y una
 * línea dice cuál se rechazó. Un comando que no reproduce la acción es peor que
 * no imprimir ninguno — es la invariante 1 al revés.
 */
export function valorSeguroParaComando(valor) {
  const s = String(valor);
  // La bandera /g hace que `test` recuerde dónde quedó entre llamadas.
  CONTROLES.lastIndex = 0;
  if (CONTROLES.test(s)) {
    return {
      seguro: false,
      motivo: "trae caracteres de control: citarlo no los desarma, y escaparlos cambiaría el valor",
    };
  }
  return { seguro: true, valor: s };
}
