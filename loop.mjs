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

import { UsageError, loadDotenv } from "./commands.mjs";

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

/** Una respuesta del modelo del cliente. Sin dependencias: `fetch` y nada más. */
export async function generar({ url, model, key }, mensajes, { timeoutMs = 120000, onDebug } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (onDebug) onDebug(`generando con ${model} en ${url}`);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages: mensajes, temperature: 0 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const razon = err?.name === "TimeoutError" ? `timeout tras ${timeoutMs} ms` : err?.message || String(err);
    throw new LlmError(`No se pudo contactar tu modelo en ${url}: ${razon}`);
  }
  const texto = await res.text();
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
  return contenido;
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
export async function correrBucle({ client, pregunta, kb, opciones, onPaso = () => {} }) {
  const { umbral, generarRespuesta, gestionado, maxResults } = opciones;
  const traza = [];
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
  const respuesta = await generar(llm, armarMensajes(pregunta, rec.chunks), { onDebug: opciones.onDebug });
  anotar({
    paso: "generar",
    ok: true,
    ms: Math.round(performance.now() - t2),
    modelo: llm.model,
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
 * La respuesta del modelo NO se imprime acá: es texto que viene de fuera y su
 * escapado es trabajo de S6. Hasta entonces solo se dice cuánto mide.
 */
export function narrar(paso, { mostrarEvidencia = false } = {}) {
  switch (paso.paso) {
    case "recuperar":
      return `· recuperar   ${paso.fragmentos} fragmentos · ${paso.ms} ms${paso.retrievalId ? ` · id ${paso.retrievalId}` : ""}`;
    case "generar":
      return `· generar     ${paso.caracteres} caracteres con ${paso.modelo} · ${paso.ms} ms${paso.declino ? " · DECLINÓ" : ""}`;
    case "verificar": {
      const r = paso.riesgo === null ? "sin riesgo declarado" : `riesgo ${paso.riesgo.toFixed(2)} (${paso.riesgoVia})`;
      const n = paso.evidencia.length;
      const ev = mostrarEvidencia ? ` · ${n} pieza${n === 1 ? "" : "s"} de evidencia` : "";
      return `· verificar   ${paso.verdict} · ${r} · ${paso.ms} ms${ev}`;
    }
    case "contrastar":
      return `· contrastar  el carril gestionado devolvió ${paso.caracteres} caracteres · ${paso.ms} ms`;
    case "decidir":
      return `\nDECISION: ${paso.decision.toUpperCase()}\n  ${paso.motivo}`;
    default:
      return `· ${paso.paso}`;
  }
}
