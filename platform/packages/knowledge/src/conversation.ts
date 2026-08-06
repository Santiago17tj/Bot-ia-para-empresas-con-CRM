import { resolvePrompt } from "@platform/observability";
import type { AIProvider } from "@platform/providers";

/**
 * Hacer buscable una pregunta de seguimiento (§10).
 *
 * **Es lo único del chat que es núcleo y no interfaz.** El resto —hilos,
 * mensajes, canales— es fontanería alrededor de `answerFromKnowledge`. Esto no:
 * es una decisión que cambia lo que se recupera y por tanto lo que se responde.
 *
 * El problema, en una línea: lo que se busca en la documentación es el TEXTO de
 * la pregunta. «¿Y a Canarias?» no se parece a ninguna frase de ningún manual,
 * así que no recupera nada y el sistema se abstiene de algo que sí sabe. Y esa
 * abstención es de las peores, porque el cliente acaba de ver que sí sabía
 * responder a la pregunta anterior.
 *
 * Vive aquí y no en la ruta de chat por la misma regla que todo lo demás: una
 * decisión tomada en la ruta es una decisión sin medir sirviéndose en
 * producción.
 */

const RESOLVE_SCHEMA = {
  type: "object",
  properties: {
    standalone: {
      type: "string",
      description: "La pregunta reescrita para que se entienda sola.",
    },
    isFollowUp: {
      type: "boolean",
      description: "false si la pregunta ya se entendía por sí misma.",
    },
  },
  required: ["standalone", "isFollowUp"],
  additionalProperties: false,
} as const;

/**
 * Cuántos turnos anteriores se le enseñan al reescritor.
 *
 * Cuatro, no la conversación entera. Un seguimiento se apoya en lo último que
 * se dijo, no en lo de hace media hora; meter todo añade coste, latencia y
 * ruido — y con una conversación larga, el modelo empieza a arrastrar temas
 * que ya se cerraron.
 */
export const RESOLVE_HISTORY_TURNS = 4;

export interface ConversationTurn {
  role: "USER" | "ASSISTANT";
  content: string;
}

export interface ResolvedQuestion {
  /** Lo que se va a buscar. */
  question: string;
  /** Hubo que reescribirla. */
  rewritten: boolean;
  cost: number;
}

export interface ResolveOptions {
  tenantId: string;
  question: string;
  history: ConversationTurn[];
  provider: AIProvider;
  maxTurns?: number;
}

/**
 * Devuelve la pregunta que hay que buscar.
 *
 * **Sin historia no llama al modelo.** El primer mensaje de una conversación no
 * puede ser un seguimiento, así que gastar una llamada ahí sería pagar por cada
 * conversación una decisión que ya está tomada.
 *
 * **Falla hacia delante.** Si la reescritura no sale —el proveedor está caído,
 * el modelo devuelve algo ilegible— se busca la pregunta original. Recupera
 * peor, pero el producto sigue respondiendo; abortar la conversación por no
 * poder reformular sería cambiar un resultado mediocre por ninguno.
 */
export async function resolveQuestion(
  options: ResolveOptions,
): Promise<ResolvedQuestion> {
  const question = options.question.trim();
  const history = options.history.slice(-(options.maxTurns ?? RESOLVE_HISTORY_TURNS));

  if (history.length === 0) {
    return { question, rewritten: false, cost: 0 };
  }

  // Sin salida estructurada no se puede distinguir la pregunta reescrita de la
  // explicación del modelo, y buscar "Claro, la pregunta sería: ¿cuánto
  // tarda...?" recupera peor que la original.
  if (!options.provider.capabilities.structuredOutput) {
    return { question, rewritten: false, cost: 0 };
  }

  try {
    const [system, user] = await Promise.all([
      resolvePrompt("knowledge.question.resolve.system", options.tenantId),
      resolvePrompt("knowledge.question.resolve.user", options.tenantId),
    ]);

    const generation = await options.provider.generate({
      system: system.render({}),
      messages: [
        {
          role: "user",
          content: user.render({
            conversacion: renderHistory(history),
            pregunta: question,
          }),
        },
      ],
      maxTokens: 200,
      outputSchema: RESOLVE_SCHEMA as unknown as Record<string, unknown>,
    });

    const parsed = parseResolution(generation.parsed);

    if (parsed === undefined || !parsed.isFollowUp) {
      return { question, rewritten: false, cost: generation.cost };
    }

    // Una reescritura vacía o absurdamente larga es peor que no reescribir: el
    // modelo se ha ido por otro lado y buscar eso recupera cualquier cosa.
    const standalone = parsed.standalone.trim();
    if (standalone === "" || standalone.length > question.length + 300) {
      return { question, rewritten: false, cost: generation.cost };
    }

    return { question: standalone, rewritten: true, cost: generation.cost };
  } catch {
    return { question, rewritten: false, cost: 0 };
  }
}

/**
 * La conversación reciente, en texto.
 *
 * Se incluyen las respuestas del asistente y no solo las preguntas: «¿y a
 * Canarias?» solo se entiende sabiendo que la respuesta anterior hablaba de
 * plazos de envío. Con solo las preguntas del cliente, el reescritor tiene la
 * mitad del contexto.
 */
function renderHistory(history: ConversationTurn[]): string {
  return history
    .map((turn) => `${turn.role === "USER" ? "Cliente" : "Asistente"}: ${turn.content}`)
    .join("\n");
}

function parseResolution(
  value: unknown,
): { standalone: string; isFollowUp: boolean } | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate["standalone"] !== "string") return undefined;
  if (typeof candidate["isFollowUp"] !== "boolean") return undefined;

  return {
    standalone: candidate["standalone"],
    isFollowUp: candidate["isFollowUp"],
  };
}
