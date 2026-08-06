import { randomUUID } from "node:crypto";

import { runWithTenant, withRlsTransaction, type Prisma } from "@platform/db";
import { ConnectorError, connectorFor, type DiscoveredDocument } from "@platform/connectors";
import { EventHandlingError, publish, type DomainEvent } from "@platform/events";
import { documentKey, type StorageDriver } from "@platform/storage";

/**
 * Consumidor de `source.sync.requested`: rastrea el origen y mete lo que
 * encuentra por la ruta de ingesta que ya existe.
 *
 * **El conector no ingiere.** Descubre y entrega bytes; a partir de ahí todo es
 * exactamente lo mismo que cuando alguien sube un fichero a mano: se guarda en
 * el almacenamiento, se crea el documento en `PENDING` y se publica
 * `document.uploaded` en la misma transacción. El troceado, los embeddings y la
 * validación son el camino que ya está medido, no uno paralelo.
 *
 * Eso es lo que hace que añadir Notion o Drive sea un fichero en
 * `@platform/connectors` y nada más.
 */

export function createSyncHandler(deps: {
  storage: StorageDriver;
  log?: (message: string) => void;
}) {
  const log = deps.log ?? ((message: string) => console.log(message));

  return async function handleSync(event: DomainEvent): Promise<void> {
    if (event.tenantId === null) {
      throw new EventHandlingError(
        "source.sync.requested sin tenantId: una fuente es de un cliente concreto.",
        true,
      );
    }

    const sourceId = readSourceId(event);
    const ctx = {
      tenantId: event.tenantId,
      actor: { type: "system" as const, id: "worker:sync", scopes: [] },
      requestId: `evt_${event.id}`,
    };

    const source = await runWithTenant(ctx, () =>
      withRlsTransaction((tx) =>
        tx.knowledgeSource.findUnique({
          where: { id: sourceId },
          select: { id: true, kind: true, config: true, syncCursor: true, isActive: true },
        }),
      ),
    );

    // Una fuente borrada entre la petición y el proceso no es un error que
    // reintentar cinco veces: ya no existe.
    if (source === null) {
      throw new EventHandlingError(`La fuente ${sourceId} ya no existe.`, true);
    }
    if (!source.isActive) {
      log(`[worker] fuente ${sourceId} desactivada: no se sincroniza`);
      return;
    }

    await setStatus(ctx, sourceId, "RUNNING", null);

    try {
      const connector = connectorFor(source.kind);
      let emitted = 0;

      const { cursor, progress } = await connector.sync(
        (source.config ?? {}) as Record<string, unknown>,
        {
          cursor: (source.syncCursor ?? {}) as Record<string, unknown>,
          log,
          emit: async (document) => {
            await ingest(ctx, sourceId, document, deps.storage);
            emitted++;
          },
        },
      );

      await runWithTenant(ctx, () =>
        withRlsTransaction(async (tx) => {
          await tx.knowledgeSource.update({
            where: { id: sourceId },
            data: {
              // El cursor solo se guarda si la sincronización terminó entera.
              // Guardarlo a medias haría que la siguiente pasada creyera ya
              // visto lo que en realidad nunca llegó a ingerirse.
              syncCursor: cursor as Prisma.InputJsonValue,
              lastSyncAt: new Date(),
              lastSyncStatus: "READY",
              lastSyncError: warningsToError(progress.warnings),
            },
          });

          await publish(tx, {
            type: "source.sync.completed",
            tenantId: ctx.tenantId,
            payload: {
              sourceId,
              discovered: progress.discovered,
              skipped: progress.skipped,
              warnings: progress.warnings.length,
            },
          });
        }),
      );

      log(
        `[worker] fuente ${sourceId}: ${emitted} documentos nuevos, ` +
          `${progress.skipped} sin cambios, ${progress.warnings.length} avisos`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setStatus(ctx, sourceId, "FAILED", message);

      // Un fallo de configuración no se arregla reintentando: se manda a la
      // cola de muertos para que se vea ya, en vez de dentro de una hora de
      // backoff.
      throw new EventHandlingError(
        `Sincronización de ${sourceId} fallida: ${message}`,
        error instanceof ConnectorError && error.permanent,
        error,
      );
    }
  };
}

/**
 * Mete un documento descubierto por la puerta normal.
 *
 * `sourceRef` es la URL, y es lo que une las pasadas sucesivas: la ingesta
 * localiza el documento existente por ese campo, así que rastrear el mismo sitio
 * mañana actualiza las páginas en vez de duplicarlas.
 */
async function ingest(
  ctx: { tenantId: string; actor: { type: "system"; id: string; scopes: never[] }; requestId: string },
  sourceId: string,
  document: DiscoveredDocument,
  storage: StorageDriver,
): Promise<void> {
  const documentId = randomUUID();
  const key = documentKey(ctx.tenantId, documentId, "html");

  // Los bytes ANTES de la transacción: es E/S y no debe mantener abierta una
  // conexión del pool.
  await storage.put(key, document.bytes, { contentType: document.mimeType });

  await runWithTenant(ctx, () =>
    withRlsTransaction(async (tx) => {
      // ¿Ya existe este documento de una pasada anterior? Se reutiliza su fila
      // para que la ingesta versione en vez de crear una nueva.
      const existing = await tx.document.findFirst({
        where: { sourceRef: document.sourceRef },
        select: { id: true },
      });

      const id = existing?.id ?? documentId;

      if (existing === null) {
        await tx.document.create({
          data: {
            id: documentId,
            tenantId: ctx.tenantId,
            sourceId,
            title: document.title ?? document.sourceRef,
            kind: "URL",
            mimeType: document.mimeType,
            storageKey: key,
            sourceRef: document.sourceRef,
            status: "PENDING",
          },
        });
      } else {
        await tx.document.update({
          where: { id },
          data: { storageKey: key, status: "PENDING", statusError: null },
        });
      }

      await publish(tx, {
        type: "document.uploaded",
        tenantId: ctx.tenantId,
        payload: {
          documentId: id,
          storageKey: key,
          filename: filenameFor(document.sourceRef),
          mimeType: document.mimeType,
          byteSize: document.bytes.byteLength,
        },
      });
    }),
  );
}

/**
 * Un nombre de fichero plausible para la URL.
 *
 * Importa porque el conversor resuelve por MIME y, si no, por extensión: una
 * URL sin `.html` que llegara sin nombre útil dejaría a la extensión sin decir
 * nada. El MIME de la respuesta manda igualmente, esto es el respaldo.
 */
function filenameFor(url: string): string {
  try {
    const { pathname } = new URL(url);
    const last = pathname.split("/").filter((p) => p !== "").pop();
    if (last === undefined) return "index.html";
    return /\.\w{2,5}$/.test(last) ? last : `${last}.html`;
  } catch {
    return "pagina.html";
  }
}

/**
 * Los avisos se guardan como "error" de la última sincronización.
 *
 * No es un abuso del campo: una fuente que terminó pero dejó veinte páginas sin
 * rastrear tiene algo que mirar, y no tenerlo a la vista es lo que hace que un
 * sitio a medias parezca completo.
 */
function warningsToError(warnings: string[]): string | null {
  if (warnings.length === 0) return null;
  return `${warnings.length} aviso(s): ${warnings.slice(0, 5).join(" · ")}`.slice(0, 2_000);
}

async function setStatus(
  ctx: { tenantId: string; actor: { type: "system"; id: string; scopes: never[] }; requestId: string },
  sourceId: string,
  status: "RUNNING" | "FAILED",
  error: string | null,
): Promise<void> {
  try {
    await runWithTenant(ctx, () =>
      withRlsTransaction((tx) =>
        tx.knowledgeSource.update({
          where: { id: sourceId },
          data: { lastSyncStatus: status, lastSyncError: error?.slice(0, 2_000) ?? null },
        }),
      ),
    );
  } catch {
    // Si ni el estado se puede escribir, lo que queda es la excepción que sube
    // al despachador.
  }
}

function readSourceId(event: DomainEvent): string {
  const payload = event.payload as Record<string, unknown> | null;
  const sourceId = payload?.["sourceId"];

  if (typeof sourceId !== "string" || sourceId === "") {
    throw new EventHandlingError("source.sync.requested exige sourceId", true);
  }
  return sourceId;
}
