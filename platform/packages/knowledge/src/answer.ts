import { resolvePrompt, type ResolvedPrompt } from "@platform/observability";
import { ProviderError, type AIProvider } from "@platform/providers";

import {
  ANSWER_SCHEMA,
  fallbackAnswer,
  validateGrounding,
  type GroundedAnswer,
  type ValidationFailure,
} from "./grounding.js";
import type { RetrievalHit } from "./retrieval.js";

/**
 * Respuesta fundada: capas 4–6 del grounding (§12.2).
 *
 * Es la pieza que faltaba para que el arnés midiera abstención de verdad. Hasta
 * ahora la única defensa era el umbral de similitud —capa 1—, y la medición
 * demostró que no sirve para eso: sobre `multilingual-e5-small` las preguntas
 * respondibles y las que no tienen respuesta se separan por 0,0075 de coseno.
 *
 * Aquí la abstención la decide quien puede decidirla: un modelo que tiene los
 * fragmentos delante, ve que no contestan la pregunta y devuelve
 * `answered: false`. Y lo que dice se comprueba en código antes de que llegue a
 * nadie.
 *
 * Vive en `knowledge` y no en `eval` a propósito: esto es la ruta de producción
 * de `/v1/answer`. Si viviera en el arnés, el arnés mediría un camino que no es
 * el que se sirve, que es la forma más cara de tener una métrica verde.
 */

export interface AnswerOptions {
  tenantId: string;
  question: string;
  /** Lo recuperado, ya filtrado por umbral. */
  hits: RetrievalHit[];
  provider: AIProvider;

  /** Reglas del ADN del tenant que deben condicionar la respuesta. */
  rules?: string[];
  /** Prohibiciones, verificadas también sobre la SALIDA. */
  prohibitions?: string[];
  /** Qué se responde cuando no hay respuesta fundada. */
  fallbackMessage: string;

  maxTokens?: number;
  temperature?: number;
}

export interface AnswerResult {
  answer: GroundedAnswer;
  /** Fallos de la validación. Vacío no significa que respondiera: puede haberse abstenido. */
  failures: ValidationFailure[];
  /**
   * El modelo respondió algo y la validación lo tumbó.
   *
   * Se distingue de una abstención normal porque significan cosas opuestas:
   * abstenerse es el sistema funcionando; degradar es el modelo intentando
   * inventar y la red de debajo aguantando. La segunda hay que contarla.
   */
  degraded: boolean;

  cost: number;
  latencyMs: number;
  model: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  /** Qué versión de cada prompt produjo esto. Sin esto una regresión no se diagnostica. */
  promptVersions: { key: string; version: number; versionId: string }[];
}

/**
 * Genera una respuesta y la valida contra sus fuentes.
 *
 * Ninguna de las salidas posibles es "prosa del modelo tal cual": o valida, o
 * se sirve el mensaje de reserva del tenant.
 */
export async function answerFromKnowledge(options: AnswerOptions): Promise<AnswerResult> {
  // Sin esquema no hay citas exigibles, y sin citas exigibles esto es un
  // chatbot que suena fundado. Se falla al entrar, no tras gastar una llamada.
  if (!options.provider.capabilities.structuredOutput) {
    throw new ProviderError(
      `${options.provider.id}/${options.provider.model} no admite salida ` +
        "estructurada. Sin ella las citas son una petición al modelo en vez de " +
        "una obligación verificable, y la medición de abstención no significa nada.",
      options.provider.id,
      false,
    );
  }

  const [system, user] = await Promise.all([
    resolvePrompt("knowledge.answer.system", options.tenantId),
    resolvePrompt("knowledge.answer.user", options.tenantId),
  ]);

  const rules = [...(options.rules ?? []), ...(options.prohibitions ?? [])];

  const generation = await options.provider.generate({
    system: system.render({ reglas: renderRules(rules) }),
    messages: [
      {
        role: "user",
        content: user.render({
          contexto: renderContext(options.hits),
          pregunta: options.question,
        }),
      },
    ],
    maxTokens: options.maxTokens ?? 1024,
    outputSchema: ANSWER_SCHEMA as unknown as Record<string, unknown>,
    cacheSystemPrompt: true,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  });

  const promptVersions = [system, user].map(descriptorOf);
  const base = {
    cost: generation.cost,
    latencyMs: generation.latencyMs,
    model: generation.model,
    usage: generation.usage,
    promptVersions,
  };

  const parsed = parseAnswer(generation.parsed);
  if (parsed === undefined) {
    // Salida ilegible. Se abstiene: no se intenta rescatar prosa de un JSON
    // roto, porque lo que se rescataría no tendría citas comprobadas.
    return {
      answer: fallbackAnswer(options.fallbackMessage),
      failures: [
        {
          kind: "malformed",
          detail:
            generation.stopReason === "max_tokens"
              ? "la respuesta se cortó por límite de tokens"
              : `salida no conforme al esquema (stopReason: ${generation.stopReason})`,
        },
      ],
      degraded: true,
      ...base,
    };
  }

  const validation = validateGrounding(parsed, options.hits, options.prohibitions ?? []);

  if (!validation.valid) {
    return {
      answer: fallbackAnswer(options.fallbackMessage),
      failures: validation.failures,
      degraded: true,
      ...base,
    };
  }

  return { answer: parsed, failures: [], degraded: false, ...base };
}

/**
 * Convierte la salida del modelo en un `GroundedAnswer` o en nada.
 *
 * No normaliza ni rellena huecos: un objeto al que le falta `citations` no es
 * una respuesta con cero citas, es una respuesta que no cumplió el contrato.
 * Tratarla como lo primero sería inventar en el sitio donde más caro sale.
 */
function parseAnswer(value: unknown): GroundedAnswer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;

  if (typeof candidate["answered"] !== "boolean") return undefined;
  if (typeof candidate["response"] !== "string") return undefined;
  if (!Array.isArray(candidate["citations"])) return undefined;

  const citations: { chunkId: string; quote: string }[] = [];
  for (const raw of candidate["citations"]) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const entry = raw as Record<string, unknown>;
    if (typeof entry["chunkId"] !== "string" || typeof entry["quote"] !== "string") {
      return undefined;
    }
    citations.push({ chunkId: entry["chunkId"], quote: entry["quote"] });
  }

  // `rulesApplied` viaja como anulable por el modo estricto de los backends
  // compatibles con OpenAI: allí toda propiedad es obligatoria y la que era
  // opcional se expresa admitiendo null.
  const rulesApplied = candidate["rulesApplied"];
  const applied = Array.isArray(rulesApplied)
    ? rulesApplied.filter((r): r is string => typeof r === "string")
    : undefined;

  return {
    answered: candidate["answered"],
    response: candidate["response"],
    citations,
    ...(applied === undefined ? {} : { rulesApplied: applied }),
  };
}

/**
 * Serializa los fragmentos para el turno de usuario.
 *
 * El identificador va delante y entre corchetes porque es lo que el modelo debe
 * copiar en `chunkId`, y las migas de pan van detrás: sin ellas un fragmento
 * suelto pierde de qué sección hablaba, y el modelo responde de la política de
 * devoluciones creyendo que lee la de envíos.
 *
 * Esto es marshalling, no prompt: qué hacer con estos fragmentos lo dice el
 * prompt de sistema, que vive en el registro.
 */
export function renderContext(hits: RetrievalHit[]): string {
  return hits
    .map((hit) => {
      const path = [hit.title, ...hit.breadcrumbs].filter(
        (part): part is string => part !== null && part !== "",
      );
      const heading = path.length > 0 ? ` (${path.join(" › ")})` : "";
      return `[${hit.chunkId}]${heading}\n${hit.content}`;
    })
    .join("\n\n");
}

function renderRules(rules: string[]): string {
  // Una lista vacía se dice en voz alta. El hueco en blanco deja al modelo
  // decidiendo qué significa una sección REGLAS sin contenido.
  return rules.length === 0
    ? "No hay reglas específicas para este cliente."
    : rules.map((rule) => `- ${rule}`).join("\n");
}

function descriptorOf(prompt: ResolvedPrompt): {
  key: string;
  version: number;
  versionId: string;
} {
  return { key: prompt.key, version: prompt.version, versionId: prompt.versionId };
}
