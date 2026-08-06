import { resolvePrompt } from "@platform/observability";
import type { AIProvider } from "@platform/providers";

import type { GapCandidate, GapMatcher } from "./gaps.js";

/**
 * El decisor de huecos: quien dice si dos preguntas son la misma.
 *
 * Existe porque la similitud coseno no puede hacerlo. Está medido en
 * `packages/eval/scripts/calibrate-gaps.mjs`: sobre multilingual-e5-small, las
 * preguntas equivalentes puntúan 0,842–0,939 y las distintas del mismo tema
 * 0,885–0,948. Se solapan enteros, y el par más parecido de la muestra son dos
 * preguntas distintas. No hay umbral que sirva.
 *
 * El vector preselecciona candidatos baratos; aquí se decide entre ellos. Es el
 * mismo reparto que ya usa la abstención, y la segunda vez que este proyecto
 * llega a la misma conclusión por medición.
 */

const MATCH_SCHEMA = {
  type: "object",
  properties: {
    matchId: {
      // Anulable de verdad, no opcional: "ninguno de estos" es la respuesta
      // correcta la mayoría de las veces y tiene que poder expresarse.
      type: ["string", "null"],
      description: "Id del hueco equivalente, o null si la pregunta es nueva.",
    },
    reasoning: { type: "string" },
  },
  required: ["matchId", "reasoning"],
  additionalProperties: false,
} as const;

export interface GapMatcherOptions {
  tenantId: string;
  provider: AIProvider;
  /** Se llama con la decisión y su motivo. Útil para auditar el agrupamiento. */
  onDecision?: (decision: { matchId: string | null; reasoning: string }) => void;
}

/**
 * Construye el decisor, o `undefined` si este proveedor no puede serlo.
 *
 * Sin salida estructurada no se agrupa. Es la misma regla que en la respuesta:
 * un modelo al que se le pide un id y devuelve prosa produciría agrupamientos
 * inventados, y un hueco absorbido por otro que no le corresponde desaparece
 * del informe sin que nadie lo note.
 */
export function createGapMatcher(options: GapMatcherOptions): GapMatcher | undefined {
  if (!options.provider.capabilities.structuredOutput) return undefined;

  return async (question, candidates) => {
    const [system, user] = await Promise.all([
      resolvePrompt("knowledge.gap.match.system", options.tenantId),
      resolvePrompt("knowledge.gap.match.user", options.tenantId),
    ]);

    const generation = await options.provider.generate({
      system: system.render({}),
      messages: [
        {
          role: "user",
          content: user.render({
            pregunta: question,
            candidatos: renderCandidates(candidates),
          }),
        },
      ],
      // La respuesta son dos campos cortos. Un techo generoso aquí solo permite
      // que un modelo hablador se explaye en `reasoning` y pague por ello.
      maxTokens: 300,
      outputSchema: MATCH_SCHEMA as unknown as Record<string, unknown>,
    });

    const decision = parseDecision(generation.parsed);
    if (decision === undefined) return null;

    options.onDecision?.(decision);

    // Un id que no estaba entre los candidatos se descarta aquí también,
    // aunque `recordGap` lo vuelva a comprobar. Dos redes para lo mismo, porque
    // el fallo —un hueco absorbido por otro que no existe— es silencioso.
    if (decision.matchId === null) return null;
    return candidates.some((c) => c.id === decision.matchId) ? decision.matchId : null;
  };
}

/**
 * Los candidatos, con sus formulaciones alternativas.
 *
 * Las variantes van incluidas porque son parte de la evidencia: un hueco que ya
 * agrupó "¿puedo pagar a plazos?" hace más reconocible que "¿hacéis
 * financiación?" es el mismo, y sin ellas el modelo decide con menos de lo que
 * hay.
 */
function renderCandidates(candidates: GapCandidate[]): string {
  return candidates
    .map((candidate) => {
      const variants =
        candidate.variants.length === 0
          ? ""
          : `\n   también preguntado como: ${candidate.variants.join(" · ")}`;
      return `[${candidate.id}] ${candidate.question}${variants}`;
    })
    .join("\n\n");
}

function parseDecision(
  value: unknown,
): { matchId: string | null; reasoning: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const candidate = value as Record<string, unknown>;
  const matchId = candidate["matchId"];
  const reasoning = candidate["reasoning"];

  if (matchId !== null && typeof matchId !== "string") return undefined;

  return {
    matchId: matchId === null || matchId === "" ? null : matchId,
    reasoning: typeof reasoning === "string" ? reasoning : "",
  };
}
