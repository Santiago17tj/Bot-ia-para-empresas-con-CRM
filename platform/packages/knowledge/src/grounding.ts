import type { RetrievalHit } from "./retrieval.js";

/**
 * Validación de grounding (§12.2, capas 4–6).
 *
 * El modelo no devuelve prosa libre: devuelve una estructura con citas. Este
 * módulo comprueba EN CÓDIGO que esas citas existen y son literales. Lo que
 * falla aquí NO llega al usuario.
 *
 * Es la diferencia entre pedirle al modelo que no invente y comprobar que no
 * inventó.
 */

export interface Citation {
  chunkId: string;
  /** Fragmento literal del texto citado. */
  quote: string;
}

export interface GroundedAnswer {
  answered: boolean;
  response: string;
  citations: Citation[];
  rulesApplied?: string[];
}

/** Esquema JSON que se le exige al modelo. */
export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answered: {
      type: "boolean",
      description:
        "false si los fragmentos no contienen la respuesta. Es un resultado correcto, no un fallo.",
    },
    response: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          chunkId: { type: "string" },
          quote: {
            type: "string",
            description: "Texto LITERAL del fragmento, copiado sin reformular.",
          },
        },
        required: ["chunkId", "quote"],
        additionalProperties: false,
      },
    },
    rulesApplied: { type: "array", items: { type: "string" } },
  },
  required: ["answered", "response", "citations"],
  additionalProperties: false,
} as const;

export type ValidationFailure =
  | { kind: "unknown_chunk"; chunkId: string }
  | { kind: "quote_not_found"; chunkId: string; quote: string }
  | { kind: "answered_without_citations" }
  | { kind: "prohibited_content"; rule: string }
  | { kind: "malformed"; detail: string };

export interface ValidationResult {
  valid: boolean;
  failures: ValidationFailure[];
}

/**
 * Normaliza para comparar citas.
 *
 * Se ignoran espacios, mayúsculas y acentos: un modelo que copia bien pero
 * normaliza un espacio duro o pierde una tilde al reproducir está citando
 * correctamente, y rechazarlo por eso convertiría una respuesta buena en una
 * abstención. Lo que NO se tolera es que el texto no esté.
 */
export function normalizeForComparison(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Valida una respuesta contra los fragmentos que se le pasaron al modelo.
 *
 * Tres comprobaciones, y ninguna es opcional:
 *  - Todo `chunkId` citado estaba entre los recuperados. Un id inventado es la
 *    firma de una cita fabricada.
 *  - Cada `quote` aparece de verdad en su fragmento. Un id correcto con texto
 *    inventado es más difícil de detectar y más peligroso.
 *  - `answered: true` exige al menos una cita. Afirmar sin fuente es
 *    exactamente lo que este sistema existe para impedir.
 */
export function validateGrounding(
  answer: GroundedAnswer,
  retrieved: RetrievalHit[],
  prohibitions: string[] = [],
): ValidationResult {
  const failures: ValidationFailure[] = [];

  if (!answer.answered) {
    // Una abstención no necesita citas. Es un resultado correcto.
    return { valid: true, failures: [] };
  }

  if (answer.citations.length === 0) {
    failures.push({ kind: "answered_without_citations" });
  }

  const byId = new Map(retrieved.map((hit) => [hit.chunkId, hit]));

  for (const citation of answer.citations) {
    const hit = byId.get(citation.chunkId);
    if (hit === undefined) {
      failures.push({ kind: "unknown_chunk", chunkId: citation.chunkId });
      continue;
    }

    const haystack = normalizeForComparison(hit.content);
    const needle = normalizeForComparison(citation.quote);

    if (needle.length === 0 || !haystack.includes(needle)) {
      failures.push({
        kind: "quote_not_found",
        chunkId: citation.chunkId,
        quote: citation.quote,
      });
    }
  }

  // Las prohibiciones del ADN se comprueban también en la SALIDA, no solo al
  // ensamblar el contexto: una prohibición que solo vive en el prompt es una
  // prohibición que se incumple el día que la conversación es larga.
  const normalized = normalizeForComparison(answer.response);
  for (const rule of prohibitions) {
    const marker = extractProhibitedMarker(rule);
    if (marker !== undefined && normalized.includes(normalizeForComparison(marker))) {
      failures.push({ kind: "prohibited_content", rule });
    }
  }

  return { valid: failures.length === 0, failures };
}

/**
 * Extrae el término vigilable de una prohibición escrita en lenguaje natural.
 *
 * Deliberadamente simple y deliberadamente insuficiente por sí sola: detecta
 * el caso obvio ("nunca menciones X" con X literal en la respuesta) y no
 * pretende interpretar la regla. La contención real es que la prohibición viaja
 * en el contexto y nunca se trunca; esto es la red de debajo, no el suelo.
 */
function extractProhibitedMarker(rule: string): string | undefined {
  const match = /nunca\s+(?:menciones|digas|uses|nombres)\s+(.+?)[.;]?$/i.exec(rule);
  return match?.[1]?.trim();
}

/**
 * Qué se devuelve cuando la validación falla.
 *
 * Se devuelve el mensaje de reserva del tenant, NO la respuesta del modelo. Una
 * respuesta con una cita inventada es peor que una abstención, porque parece
 * fundada.
 */
export function fallbackAnswer(fallbackMessage: string): GroundedAnswer {
  return { answered: false, response: fallbackMessage, citations: [] };
}
