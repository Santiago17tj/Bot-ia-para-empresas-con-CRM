import type { Prisma } from "@platform/db";

import type { EventType } from "./types.js";

/**
 * La mitad de escritura del outbox transaccional.
 *
 * `publish` EXIGE un cliente de transacción. No es una molestia de la API: es
 * la garantía entera. Un `publish` que abriera su propia conexión podría
 * confirmarse mientras el cambio que lo motivó se revierte — o al revés — y
 * entonces el outbox deja de ser una garantía y pasa a ser una probabilidad.
 */

export interface PublishOptions {
  type: EventType;
  tenantId?: string | null;
  payload: unknown;
  /** Retrasa el primer intento. Útil para stand-downs y reintentos programados. */
  delayMs?: number;
  maxAttempts?: number;
}

/**
 * Escribe un evento en el outbox dentro de la transacción del llamante.
 *
 * @example
 * await prisma.$transaction(async (tx) => {
 *   const doc = await tx.document.create({ data });
 *   await publish(tx, { type: "document.uploaded", tenantId, payload: { id: doc.id } });
 * });
 */
export async function publish(
  tx: Prisma.TransactionClient,
  options: PublishOptions,
): Promise<void> {
  // Sin retraso NO se fija `availableAt`: lo pone el default de la columna,
  // que es `CURRENT_TIMESTAMP` de Postgres.
  //
  // Parece un detalle y no lo es. El despachador reclama con
  // `availableAt <= now()`, y ese `now()` es el reloj de POSTGRES. Poniendo
  // aquí `new Date()` —el reloj de NODE— se comparan dos relojes distintos, y
  // si el de Postgres va detrás el evento es invisible hasta que lo alcanza.
  // Medido en esta máquina: 6 ms de desfase.
  //
  // En producción no se nota, porque el worker sondea cada dos segundos y seis
  // milisegundos se pierden en el ruido. Se notaba en los tests, que publican y
  // drenan seguido: caían dentro de la ventana, `drain()` no encontraba nada,
  // `drainAll` cortaba en la primera pasada por `processed === 0`, y el
  // documento se quedaba en PENDING. Un test intermitente cuya causa real era
  // comparar dos relojes.
  const delayed =
    options.delayMs !== undefined && options.delayMs > 0
      ? { availableAt: new Date(Date.now() + options.delayMs) }
      : {};

  await tx.outboxEvent.create({
    data: {
      type: options.type,
      tenantId: options.tenantId ?? null,
      payload: options.payload as Prisma.InputJsonValue,
      ...delayed,
      maxAttempts: options.maxAttempts ?? 5,
    },
  });
}

/** Publica varios eventos en la misma transacción. */
export async function publishMany(
  tx: Prisma.TransactionClient,
  events: PublishOptions[],
): Promise<void> {
  if (events.length === 0) return;

  // Mismo criterio que `publish`: sin retraso lo pone el default de Postgres.
  const now = Date.now();
  await tx.outboxEvent.createMany({
    data: events.map((e) => ({
      type: e.type,
      tenantId: e.tenantId ?? null,
      payload: e.payload as Prisma.InputJsonValue,
      ...(e.delayMs !== undefined && e.delayMs > 0
        ? { availableAt: new Date(now + e.delayMs) }
        : {}),
      maxAttempts: e.maxAttempts ?? 5,
    })),
  });
}

/**
 * Retroceso exponencial con jitter, en milisegundos.
 *
 * El jitter no es cosmético: sin él, N consumidores que fallan por la misma
 * causa (una API caída) reintentan todos en el mismo instante y la tumban otra
 * vez en cuanto se recupera.
 */
export function backoffMs(attempts: number): number {
  const base = Math.min(1000 * 2 ** attempts, 5 * 60_000);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}
