import "@platform/env/load";

import { optional } from "@platform/env";
import { EventDispatcher } from "@platform/events";
import { createAIProvider, createEmbeddingProvider } from "@platform/providers";
import { createStorage } from "@platform/storage";

import { createGapHandler } from "./gap-handler.js";
import { createIngestHandler } from "./ingest-handler.js";
import { runDueSyncs } from "./scheduler.js";
import { createSyncHandler } from "./sync-handler.js";

export { createGapHandler } from "./gap-handler.js";
export type { GapPayload } from "./gap-handler.js";
export { createIngestHandler } from "./ingest-handler.js";
export type { UploadedPayload } from "./ingest-handler.js";
export { createSyncHandler } from "./sync-handler.js";
export { runDueSyncs } from "./scheduler.js";
export type { SchedulerResult } from "./scheduler.js";

/**
 * Worker de ingesta.
 *
 * **Proceso aparte de la API, y por una razón medida.** El proveedor de
 * embeddings local corre ONNX en CPU y bloquea el event loop de Node mientras
 * lo hace: durante los tests llegamos a ver a Prisma reportar "can't reach
 * database server" en medio de un embed pesado, con la base perfectamente viva.
 * Dentro del proceso de la API, ingerir un manual dejaría al servidor sin
 * responder a nadie durante minutos.
 *
 * Separarlos además permite escalarlos distinto —muchas peticiones y poca
 * ingesta, o al revés— y reiniciar uno sin tirar el otro.
 *
 * Varios workers a la vez son correctos: el despachador reclama con
 * `FOR UPDATE SKIP LOCKED`, así que se reparten el trabajo sin pisarse.
 */

export function buildDispatcher(): EventDispatcher {
  const dispatcher = new EventDispatcher({
    workerId: optional("WORKER_ID") ?? `ingest-${process.pid}`,
    // Un lote pequeño porque cada evento aquí puede tardar minutos: reclamar 25
    // documentos de golpe los dejaría con el lease vencido antes de llegar al
    // último, y otro worker se los llevaría a medio hacer.
    batchSize: Number(optional("WORKER_BATCH_SIZE") ?? 3),
    // Generoso por lo mismo: el lease tiene que sobrevivir a la ingesta más
    // larga que quepa, o el trabajo se duplica.
    leaseMs: Number(optional("WORKER_LEASE_MS") ?? 600_000),
    onError: (event, handlerName, error) => {
      console.error(
        `[worker] ${handlerName} falló en ${event.type} (${event.id}, intento ${event.attempts}):`,
        error instanceof Error ? error.message : String(error),
      );
    },
  });

  // UN solo proveedor para los dos consumidores. Construir dos carga el modelo
  // de 120 MB dos veces y duplica la memoria del proceso a cambio de nada: la
  // carga es perezosa y compartir la instancia es lo que la hace ocurrir una vez.
  const embedder = createEmbeddingProvider();
  const storage = createStorage();

  dispatcher.on("document.uploaded", "ingest", createIngestHandler({ storage, embedder }));

  dispatcher.on("source.sync.requested", "sync", createSyncHandler({ storage }));

  // El generador puede no estar configurado: sin él se registran los huecos
  // igual, solo que sin agrupar. Un dato peor presentado sigue siendo el dato;
  // no registrarlo sería perderlo para siempre.
  let provider;
  try {
    provider = createAIProvider();
  } catch {
    console.warn(
      "[worker] sin generador configurado: los huecos se registran sin agrupar.",
    );
  }

  dispatcher.on(
    "knowledge.gap",
    "gaps",
    createGapHandler({ embedder, ...(provider === undefined ? {} : { provider }) }),
  );

  return dispatcher;
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]));

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

if (isEntrypoint) {
  const dispatcher = buildDispatcher();
  const intervalMs = Number(optional("WORKER_POLL_MS") ?? 2_000);

  console.log(
    `[worker] escuchando ${dispatcher.registeredTypes.join(", ")} cada ${intervalMs} ms`,
  );

  let stopping = false;

  const tick = async (): Promise<void> => {
    // Recuperar leases vencidos antes de reclamar: un worker que murió a media
    // entrega dejó trabajo reclamado que nadie va a terminar, y sin esto la
    // cola no crece — simplemente ese documento no se indexa nunca.
    await dispatcher.reclaimExpired();
    // El planificador va ANTES de vaciar la cola: lo que dispare este minuto se
    // procesa en la misma pasada en vez de esperar a la siguiente.
    await runDueSyncs(new Date(), (message) => console.log(message));
    await dispatcher.drainAll();
  };

  const loop = async (): Promise<void> => {
    while (!stopping) {
      try {
        await tick();
      } catch (error) {
        // El bucle no muere por un fallo: si la base se cae un minuto, el
        // worker tiene que seguir vivo para retomar cuando vuelva.
        console.error(
          "[worker] error en el ciclo:",
          error instanceof Error ? error.message : String(error),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };

  void loop();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log("[worker] parando; el evento en curso termina antes de salir");
      stopping = true;
      // No se mata el proceso a secas: el evento en vuelo tiene su lease, y
      // cortarlo dejaría una transacción de escritura a medias.
      setTimeout(() => process.exit(0), 1_000).unref();
    });
  }
}
