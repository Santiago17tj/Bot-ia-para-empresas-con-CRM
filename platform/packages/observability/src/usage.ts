import { publish, type PublishOptions } from "@platform/events";
import type { Prisma } from "@platform/db";

/**
 * Medición de consumo (§30 del plan).
 *
 * Se emite desde el día uno porque **el consumo pasado no se reconstruye**.
 * Retrofitear medición es imposible: cuando alguien quiera facturar, los meses
 * anteriores simplemente no existen.
 */

export type UsageMetric =
  | "INPUT_TOKENS"
  | "OUTPUT_TOKENS"
  | "CACHED_TOKENS"
  | "EMBEDDINGS"
  | "STORAGE_BYTES"
  | "DOCUMENTS"
  | "CHUNKS"
  | "API_CALLS"
  | "SEARCHES"
  | "ANSWERS";

export interface UsageEntry {
  metric: UsageMetric;
  quantity: number;
  cost?: number;
  meta?: Record<string, unknown>;
}

/**
 * Registra consumo **a través del Event Bus**, no escribiendo la tabla.
 *
 * Es deliberado y es la diferencia entre medir y estorbar: medir no está en la
 * ruta crítica. Si el contador falla, la respuesta sale igual — el evento se
 * reintenta solo. Una escritura directa aquí convertiría un fallo de
 * contabilidad en un fallo de producto.
 */
export async function recordUsage(
  tx: Prisma.TransactionClient,
  tenantId: string,
  entries: UsageEntry[],
): Promise<void> {
  const meaningful = entries.filter((e) => e.quantity > 0);
  if (meaningful.length === 0) return;

  const options: PublishOptions = {
    type: "usage.recorded",
    tenantId,
    payload: {
      // Día UTC calculado en el productor, no en el consumidor: si se calculara
      // al consumir, un evento reintentado mañana se contabilizaría en el día
      // equivocado y los totales dejarían de cuadrar sin que nada avisara.
      periodDay: utcDay(new Date()),
      entries: meaningful,
    },
  };

  await publish(tx, options);
}

/** Medianoche UTC del día de `date`, en ISO. */
export function utcDay(date: Date): string {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  ).toISOString();
}

/**
 * Convierte el consumo de una llamada al modelo en entradas medibles.
 *
 * El coste se calcula aquí y se guarda: los precios cambian, y un informe
 * histórico que recalcula con la tarifa de hoy miente sobre lo que costó
 * entonces.
 */
export function usageFromGeneration(result: {
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  cost: number;
  model: string;
}): UsageEntry[] {
  return [
    {
      metric: "INPUT_TOKENS",
      quantity: result.usage.inputTokens,
      cost: result.cost,
      meta: { model: result.model },
    },
    {
      metric: "OUTPUT_TOKENS",
      quantity: result.usage.outputTokens,
      meta: { model: result.model },
    },
    {
      metric: "CACHED_TOKENS",
      quantity: result.usage.cachedTokens,
      meta: { model: result.model },
    },
  ];
}
