import { runWithTenant, withRlsTransaction } from "@platform/db";
import { EventHandlingError, type DomainEvent } from "@platform/events";
import { createGapMatcher, recordGap, type GapReason } from "@platform/knowledge";
import type { AIProvider, EmbeddingProvider } from "@platform/providers";

/**
 * Consumidor de `knowledge.gap`: agrupa la pregunta con sus equivalentes.
 *
 * Vive en el worker y no en la ruta por lo mismo que la ingesta: embeber la
 * pregunta y preguntarle al generador si es un hueco ya conocido no lo debe
 * pagar quien está esperando la respuesta. Y aquí duele el doble, porque la
 * abstención es justo el caso en el que ya se ha tardado más de lo normal — el
 * modelo razona más cuando decide que NO puede responder.
 *
 * La pregunta se re-embebe aquí en vez de viajar en el evento: mandar 384
 * flotantes en JSON son siete kilobytes por abstención y dejaría la cola
 * ilegible justo cuando alguien la esté mirando para entender qué pasó.
 */

const REASONS = new Set<GapReason>([
  "BELOW_THRESHOLD",
  "MODEL_ABSTAINED",
  "GROUNDING_FAILED",
]);

export interface GapPayload {
  question: string;
  reason: GapReason;
}

export function createGapHandler(deps: {
  embedder: EmbeddingProvider;
  /** Sin generador NO se agrupa: cada abstención abre su propia fila. */
  provider?: AIProvider;
  log?: (message: string) => void;
}) {
  const log = deps.log ?? ((message: string) => console.log(message));

  return async function handleGap(event: DomainEvent): Promise<void> {
    if (event.tenantId === null) {
      throw new EventHandlingError(
        "knowledge.gap sin tenantId: un hueco es de un cliente concreto.",
        true,
      );
    }

    const payload = parsePayload(event);

    const ctx = {
      tenantId: event.tenantId,
      actor: { type: "system" as const, id: "worker:gaps", scopes: [] },
      requestId: `evt_${event.id}`,
    };

    const match =
      deps.provider === undefined
        ? undefined
        : createGapMatcher({ tenantId: ctx.tenantId, provider: deps.provider });

    const result = await runWithTenant(ctx, () =>
      recordGap(
        { tenantId: ctx.tenantId, question: payload.question, reason: payload.reason },
        {
          embedder: deps.embedder,
          transaction: withRlsTransaction,
          ...(match === undefined ? {} : { match }),
        },
      ),
    );

    log(
      result.grouped
        ? `[worker] hueco agrupado (${result.occurrences} veces): ${payload.question}`
        : `[worker] hueco NUEVO (${result.candidatesConsidered} candidatos ` +
            `descartados): ${payload.question}`,
    );
  };
}

/**
 * Valida el payload.
 *
 * Un motivo desconocido es permanente: el enum lo fija el esquema, así que un
 * valor que no está en él es un error de código nuestro, no algo que mejore
 * reintentándolo cinco veces.
 */
function parsePayload(event: DomainEvent): GapPayload {
  const raw = event.payload;
  if (typeof raw !== "object" || raw === null) {
    throw new EventHandlingError("payload de knowledge.gap no es un objeto", true);
  }

  const payload = raw as Record<string, unknown>;
  const question = payload["question"];
  const reason = payload["reason"];

  if (typeof question !== "string" || question.trim() === "") {
    throw new EventHandlingError("knowledge.gap exige una pregunta", true);
  }

  if (typeof reason !== "string" || !REASONS.has(reason as GapReason)) {
    throw new EventHandlingError(
      `motivo de hueco desconocido: ${String(reason)}. Conocidos: ` +
        [...REASONS].join(", "),
      true,
    );
  }

  return { question: question.trim(), reason: reason as GapReason };
}
