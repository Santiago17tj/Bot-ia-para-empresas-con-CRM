import { randomUUID } from "node:crypto";

import { rawPrisma, runAsSystem } from "@platform/db";

import { backoffMs } from "./outbox.js";
import {
  EventHandlingError,
  type DomainEvent,
  type EventHandler,
  type EventType,
  type HandlerRegistration,
} from "./types.js";

/**
 * La mitad de lectura del outbox: reclama eventos pendientes y los entrega.
 *
 * Corre fuera de contexto de tenant a propósito — atiende a todos los clientes
 * — y por eso usa `rawPrisma` dentro de `runAsSystem`, que exige un motivo por
 * escrito. Un despachador que abriese un contexto de tenant tendría que elegir
 * cuál, y esa elección no existe.
 */

export interface DispatcherOptions {
  batchSize?: number;
  /** Un evento reclamado y no resuelto en este tiempo vuelve a la cola. */
  leaseMs?: number;
  workerId?: string;
  onError?: (event: DomainEvent, handlerName: string, error: unknown) => void;
}

interface ClaimedRow {
  id: string;
  type: string;
  tenantId: string | null;
  payload: unknown;
  attempts: number;
  createdAt: Date;
}

export class EventDispatcher {
  readonly #handlers = new Map<EventType, HandlerRegistration[]>();
  readonly #workerId: string;
  readonly #batchSize: number;
  readonly #leaseMs: number;
  readonly #onError: DispatcherOptions["onError"];

  constructor(options: DispatcherOptions = {}) {
    this.#workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.#batchSize = options.batchSize ?? 25;
    this.#leaseMs = options.leaseMs ?? 60_000;
    this.#onError = options.onError;
  }

  /**
   * Registra un consumidor.
   *
   * Varios consumidores pueden atender el mismo tipo. Si uno falla, el evento
   * se reintenta ENTERO y los que ya habían funcionado vuelven a ejecutarse —
   * de ahí que la idempotencia sea un requisito del consumidor y no una
   * recomendación. La alternativa (rastrear el progreso por consumidor) es una
   * tabla más y una máquina de estados más, y no compensa hasta que exista un
   * consumidor que de verdad no pueda ser idempotente.
   */
  on<TPayload = unknown>(
    type: EventType,
    name: string,
    handle: EventHandler<TPayload>,
  ): this {
    const list = this.#handlers.get(type) ?? [];
    list.push({ type, name, handle: handle as EventHandler });
    this.#handlers.set(type, list);
    return this;
  }

  get registeredTypes(): EventType[] {
    return [...this.#handlers.keys()];
  }

  /**
   * Devuelve a la cola los eventos cuyo lease expiró.
   *
   * Es lo que hace que un proceso muerto no se lleve trabajo con él. Sin esto,
   * una fila reclamada por un worker que murió a media entrega se queda en
   * `PROCESSING` para siempre y nadie lo nota: la cola no crece, simplemente
   * ese evento no ocurre.
   */
  async reclaimExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - this.#leaseMs);
    return runAsSystem("despachador del outbox: recuperar leases expirados", () =>
      rawPrisma.$executeRaw`
        UPDATE "outboxEvent"
        SET status = 'PENDING'::"OutboxStatus", "lockedAt" = NULL, "lockedBy" = NULL
        WHERE status = 'PROCESSING'::"OutboxStatus" AND "lockedAt" < ${cutoff}
      `,
    );
  }

  /**
   * Reclama un lote. `FOR UPDATE SKIP LOCKED` es lo que permite que varios
   * despachadores corran a la vez sin repartirse el mismo trabajo ni bloquearse
   * unos a otros.
   */
  async #claim(): Promise<ClaimedRow[]> {
    return runAsSystem("despachador del outbox: reclamar lote", () =>
      rawPrisma.$queryRaw<ClaimedRow[]>`
        UPDATE "outboxEvent" e
        SET status   = 'PROCESSING'::"OutboxStatus",
            "lockedAt" = now(),
            "lockedBy" = ${this.#workerId},
            attempts = e.attempts + 1
        FROM (
          SELECT id FROM "outboxEvent"
          WHERE status = 'PENDING'::"OutboxStatus"
            AND "availableAt" <= now()
          ORDER BY "availableAt" ASC
          LIMIT ${this.#batchSize}
          FOR UPDATE SKIP LOCKED
        ) AS candidate
        WHERE e.id = candidate.id
        RETURNING e.id, e.type, e."tenantId", e.payload, e.attempts, e."createdAt"
      `,
    );
  }

  async #markDone(id: string): Promise<void> {
    await runAsSystem("despachador del outbox: marcar entregado", () =>
      rawPrisma.outboxEvent.update({
        where: { id },
        data: { status: "DONE", processedAt: new Date(), lockedAt: null, lockedBy: null },
      }),
    );
  }

  async #markFailed(row: ClaimedRow, error: unknown, permanent: boolean): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    // `attempts` ya viene incrementado por el reclamo, así que la comparación
    // cuenta intentos consumidos, no intentos empezados.
    const exhausted = permanent || row.attempts >= (await this.#maxAttempts(row.id));

    await runAsSystem("despachador del outbox: registrar fallo", () =>
      rawPrisma.outboxEvent.update({
        where: { id: row.id },
        data: exhausted
          ? {
              status: "DEAD",
              lastError: message.slice(0, 2000),
              lockedAt: null,
              lockedBy: null,
              processedAt: new Date(),
            }
          : {
              status: "PENDING",
              lastError: message.slice(0, 2000),
              lockedAt: null,
              lockedBy: null,
              availableAt: new Date(Date.now() + backoffMs(row.attempts)),
            },
      }),
    );
  }

  async #maxAttempts(id: string): Promise<number> {
    const row = await runAsSystem("despachador del outbox: leer maxAttempts", () =>
      rawPrisma.outboxEvent.findUnique({
        where: { id },
        select: { maxAttempts: true },
      }),
    );
    return row?.maxAttempts ?? 5;
  }

  /**
   * Una pasada: recupera leases, reclama un lote y lo entrega.
   * Devuelve cuántos eventos se procesaron.
   */
  async drain(): Promise<number> {
    await this.reclaimExpired();
    const rows = await this.#claim();

    for (const row of rows) {
      const handlers = this.#handlers.get(row.type as EventType) ?? [];

      // Sin consumidores el evento se da por entregado. Es deliberado: un
      // productor no debe fallar porque nadie escuche todavía, y la fila queda
      // archivada con su payload por si luego alguien la necesita.
      if (handlers.length === 0) {
        await this.#markDone(row.id);
        continue;
      }

      const event: DomainEvent = {
        id: row.id,
        type: row.type as EventType,
        tenantId: row.tenantId,
        payload: row.payload,
        attempts: row.attempts,
        createdAt: row.createdAt,
      };

      let failure: { error: unknown; permanent: boolean } | undefined;

      for (const handler of handlers) {
        try {
          await handler.handle(event);
        } catch (error) {
          this.#onError?.(event, handler.name, error);
          failure = {
            error,
            permanent: error instanceof EventHandlingError && error.permanent,
          };
          break;
        }
      }

      if (failure === undefined) {
        await this.#markDone(row.id);
      } else {
        await this.#markFailed(row, failure.error, failure.permanent);
      }
    }

    return rows.length;
  }

  /**
   * Drena hasta vaciar la cola, con un tope de pasadas.
   *
   * El tope existe porque un consumidor que publica un evento del mismo tipo
   * que consume es un bucle que gasta dinero real, y prefiero un log raro a
   * una factura rara.
   */
  async drainAll(maxPasses = 20): Promise<number> {
    let total = 0;
    for (let pass = 0; pass < maxPasses; pass++) {
      const processed = await this.drain();
      total += processed;
      if (processed === 0) break;
    }
    return total;
  }
}
