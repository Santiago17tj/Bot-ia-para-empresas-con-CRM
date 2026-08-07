import { runWithTenant, withRlsTransaction } from "@platform/db";
import { EventHandlingError, publish, type DomainEvent } from "@platform/events";
import { ingestDocument } from "@platform/knowledge";
import type { EmbeddingProvider } from "@platform/providers";
import { StorageError, type StorageDriver } from "@platform/storage";

/**
 * Consumidor de `document.uploaded`: hace la ingesta de verdad.
 *
 * **Idempotente**, porque el despachador garantiza entrega *al menos una vez*.
 * Lo es sin esfuerzo especial: `ingestDocument` compara el checksum del
 * contenido extraído con la versión activa, así que procesar el mismo evento
 * dos veces no crea una versión nueva ni vuelve a pagar los embeddings.
 */

export interface UploadedPayload {
  documentId: string;
  storageKey: string;
  filename: string;
  mimeType?: string;
  category?: string;
  department?: string;
  tags?: string[];
}

export function createIngestHandler(deps: {
  storage: StorageDriver;
  embedder: EmbeddingProvider;
  log?: (message: string) => void;
}) {
  const log = deps.log ?? ((message: string) => console.log(message));

  return async function handleUploaded(event: DomainEvent): Promise<void> {
    const payload = parsePayload(event);

    // Sin tenant no hay nada que hacer y reintentarlo no lo va a arreglar.
    if (event.tenantId === null) {
      throw new EventHandlingError(
        "document.uploaded sin tenantId. Un documento pertenece siempre a un cliente.",
        true,
      );
    }

    const ctx = {
      tenantId: event.tenantId,
      actor: { type: "system" as const, id: "worker:ingest", scopes: [] },
      requestId: `evt_${event.id}`,
    };

    let bytes: Buffer;
    try {
      bytes = await deps.storage.get(payload.storageKey);
    } catch (error) {
      // Un fichero que no está no aparecerá por reintentarlo cinco veces. Se
      // marca permanente para que el diagnóstico salga ya y no dentro de una
      // hora de backoff.
      const missing = error instanceof StorageError && error.code === "not_found";
      await markFailed(ctx, payload.documentId, describe(error), log);
      throw new EventHandlingError(
        `No se pudieron leer los bytes de ${payload.storageKey}: ${describe(error)}`,
        missing,
        error,
      );
    }

    try {
      const result = await runWithTenant(ctx, () =>
        ingestDocument(
          {
            tenantId: ctx.tenantId,
            // Ingerir DENTRO de la fila que creó la API. Sin esto el worker
            // tendría que adivinar cuál es, y dos ficheros con el mismo nombre
            // se pisarían sin que nada fallara.
            documentId: payload.documentId,
            bytes,
            filename: payload.filename,
            ...(payload.mimeType === undefined ? {} : { mimeType: payload.mimeType }),
            ...(payload.category === undefined ? {} : { category: payload.category }),
            ...(payload.department === undefined
              ? {}
              : { department: payload.department }),
            ...(payload.tags === undefined ? {} : { tags: payload.tags }),
          },
          { embedder: deps.embedder, transaction: withRlsTransaction },
        ),
      );

      log(
        `[worker] ${payload.documentId} → READY  ` +
          `v${result.version} · ${result.chunksCreated} fragmentos` +
          (result.unchanged ? " (sin cambios)" : "") +
          (result.warnings.length > 0 ? ` · avisos: ${result.warnings.join("; ")}` : ""),
      );

      await runWithTenant(ctx, () =>
        withRlsTransaction((tx) =>
          publish(tx, {
            type: "knowledge.indexed",
            tenantId: ctx.tenantId,
            payload: {
              documentId: result.documentId,
              versionId: result.versionId,
              version: result.version,
              chunks: result.chunksCreated,
              unchanged: result.unchanged,
            },
          }),
        ),
      );
    } catch (error) {
      await markFailed(ctx, payload.documentId, describe(error), log);

      // El fallo del documento se publica además como evento: es lo que un
      // panel escucha para avisar a quien subió el fichero. Va fuera del
      // camino de la excepción original para no perderla.
      await runWithTenant(ctx, () =>
        withRlsTransaction((tx) =>
          publish(tx, {
            type: "document.ingest.failed",
            tenantId: ctx.tenantId,
            payload: { documentId: payload.documentId, error: describe(error) },
          }),
        ),
      ).catch(() => {});

      throw error;
    }
  };
}

/**
 * Deja constancia del fallo EN el documento.
 *
 * Sin esto, un documento que falla se queda en `RUNNING` para siempre y quien
 * lo subió no tiene forma de saber por qué su manual no responde preguntas. El
 * texto del error viaja a `statusError` porque lo va a leer quien puede
 * arreglarlo: casi siempre es un fichero que no se pudo convertir.
 */
async function markFailed(
  ctx: { tenantId: string; actor: { type: "system"; id: string; scopes: never[] }; requestId: string },
  documentId: string,
  reason: string,
  log: (message: string) => void = () => {},
): Promise<void> {
  try {
    // Dentro de `withRlsTransaction`, no solo de `runWithTenant`: las políticas
    // RLS leen `app.tenant_id` de la SESIÓN de Postgres, y eso solo se fija
    // dentro de la transacción. Fuera, el UPDATE no encuentra la fila y el
    // documento se queda sin su motivo de fallo, en silencio.
    await runWithTenant(ctx, () =>
      withRlsTransaction((tx) =>
        tx.document.update({
          where: { id: documentId },
          data: { status: "FAILED", statusError: reason.slice(0, 2_000) },
        }),
      ),
    );
  } catch (error) {
    // Si ni siquiera se puede marcar el fallo, la excepción sube al despachador
    // y el evento acaba en la cola de muertos. Pero el DOCUMENTO se queda en
    // PENDING para siempre y sin motivo, que es justo lo que este camino
    // existía para evitar — así que como mínimo se dice.
    //
    // No es teórico: bajo carga, `withRlsTransaction` expira por el event loop
    // bloqueado (el proveedor de embeddings corre ONNX en el hilo principal) y
    // este `catch` se lo tragaba entero.
    log(
      `[worker] no se pudo marcar FAILED el documento ${documentId}: ` +
        `${describe(error)}. Se queda en PENDING.`,
    );
  }
}

function parsePayload(event: DomainEvent): UploadedPayload {
  const raw = event.payload;
  if (typeof raw !== "object" || raw === null) {
    throw new EventHandlingError("payload de document.uploaded no es un objeto", true);
  }

  const payload = raw as Record<string, unknown>;
  const documentId = payload["documentId"];
  const storageKey = payload["storageKey"];
  const filename = payload["filename"];

  if (
    typeof documentId !== "string" ||
    typeof storageKey !== "string" ||
    typeof filename !== "string"
  ) {
    // Permanente: un payload malformado no mejora reintentándolo, y ocupar la
    // cola cinco veces solo retrasa el diagnóstico.
    throw new EventHandlingError(
      "document.uploaded exige documentId, storageKey y filename",
      true,
    );
  }

  const optional = (name: string): string | undefined => {
    const value = payload[name];
    return typeof value === "string" ? value : undefined;
  };

  const tags = payload["tags"];

  return {
    documentId,
    storageKey,
    filename,
    ...(optional("mimeType") === undefined ? {} : { mimeType: optional("mimeType") as string }),
    ...(optional("category") === undefined ? {} : { category: optional("category") as string }),
    ...(optional("department") === undefined
      ? {}
      : { department: optional("department") as string }),
    ...(Array.isArray(tags)
      ? { tags: tags.filter((t): t is string => typeof t === "string") }
      : {}),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
