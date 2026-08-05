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
  const availableAt =
    options.delayMs === undefined || options.delayMs <= 0
      ? new Date()
      : new Date(Date.now() + options.delayMs);

  await tx.outboxEvent.create({
    data: {
      type: options.type,
      tenantId: options.tenantId ?? null,
      payload: options.payload as Prisma.InputJsonValue,
      availableAt,
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

  const now = Date.now();
  await tx.outboxEvent.createMany({
    data: events.map((e) => ({
      type: e.type,
      tenantId: e.tenantId ?? null,
      payload: e.payload as Prisma.InputJsonValue,
      availableAt:
        e.delayMs === undefined || e.delayMs <= 0
          ? new Date(now)
          : new Date(now + e.delayMs),
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
