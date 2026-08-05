import { answerFromKnowledge } from "@platform/knowledge";
import type { AIProvider } from "@platform/providers";

import type { GenerateFn } from "./runner.js";

/**
 * Conecta el arnés con la ruta de respuesta de producción.
 *
 * Es deliberadamente delgado. Todo lo que decide si una respuesta vale
 * —el prompt, el esquema, la validación de citas, la degradación a
 * abstención— vive en `@platform/knowledge`, que es lo que servirá `/v1/answer`.
 * Si esta función tuviera lógica propia, el arnés estaría midiendo un sistema
 * que no es el que se despliega.
 */

export interface GeneratorOptions {
  tenantId: string;
  provider: AIProvider;
  /** Qué se responde cuando no hay respuesta fundada. */
  fallbackMessage?: string;
  rules?: string[];
  prohibitions?: string[];
  maxTokens?: number;
  temperature?: number;
}

export function createGenerator(options: GeneratorOptions): GenerateFn {
  const fallbackMessage =
    options.fallbackMessage ??
    "Eso no consta en la documentación disponible. Puedo pasarte con una persona.";

  return async (question, hits) => {
    const result = await answerFromKnowledge({
      tenantId: options.tenantId,
      question,
      hits,
      provider: options.provider,
      fallbackMessage,
      ...(options.rules === undefined ? {} : { rules: options.rules }),
      ...(options.prohibitions === undefined
        ? {}
        : { prohibitions: options.prohibitions }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
    });

    return {
      answered: result.answer.answered,
      response: result.answer.response,
      citations: result.answer.citations,
      cost: result.cost,
      // Solo se informan los fallos que TUMBARON una respuesta. Una abstención
      // limpia no tiene fallos que contar, y meterla en esta métrica haría
      // parecer roto justo el comportamiento que queremos.
      ...(result.failures.length === 0
        ? {}
        : { groundingFailures: result.failures.map(describeFailure) }),
    };
  };
}

/** Un fallo legible por quien lea el informe, no por quien lea el código. */
function describeFailure(failure: {
  kind: string;
  chunkId?: string;
  quote?: string;
  rule?: string;
  detail?: string;
}): string {
  switch (failure.kind) {
    case "unknown_chunk":
      return `cita un fragmento que no se le dio (${failure.chunkId ?? "?"})`;
    case "quote_not_found":
      return `la cita no aparece en el fragmento ${failure.chunkId ?? "?"}: "${(
        failure.quote ?? ""
      ).slice(0, 60)}"`;
    case "answered_without_citations":
      return "afirmó algo sin citar ninguna fuente";
    case "prohibited_content":
      return `incumplió una prohibición del ADN: ${failure.rule ?? "?"}`;
    case "malformed":
      return `salida ilegible: ${failure.detail ?? "?"}`;
    default:
      return failure.kind;
  }
}
