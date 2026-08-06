import { Prisma, type Prisma as PrismaNS } from "@platform/db";
import type { EmbeddingProvider } from "@platform/providers";

import { columnForDimensions } from "./dimensions.js";
import { embedQuery } from "./ingest.js";

/**
 * Huecos de conocimiento (§9, Knowledge Health).
 *
 * Cada abstención dice algo que la empresa no sabe por ningún otro medio: sus
 * clientes preguntan por X y su documentación no lo cubre. Es conocimiento que
 * **genera la plataforma**, no que le den, y se registra desde el día uno por
 * el mismo motivo que el consumo: **el pasado no se reconstruye**.
 *
 * ---
 *
 * **El coseno recupera; el generador decide.** Esta es la segunda vez que el
 * proyecto se encuentra con lo mismo, y la primera en que ya sabíamos buscarlo.
 *
 * Agrupar por similitud parecía obvio: dos formas de preguntar lo mismo tienen
 * que estar cerca en el espacio de embeddings. La medición
 * (`packages/eval/scripts/calibrate-gaps.mjs`, sobre multilingual-e5-small) dice
 * que no, y además al revés:
 *
 *   Equivalentes ("¿ofrecéis financiación?" ≈ "¿puedo pagar a plazos?")
 *                                                     0,842 – 0,939
 *   Distintas    ("¿cuánto cuesta el envío?" ≠ "¿cuánto tarda el envío?")
 *                                                     0,885 – 0,948
 *
 * Se solapan enteros. El par MÁS parecido de la muestra (0,948) son dos
 * preguntas distintas —coste y plazo del mismo envío— y el MENOS parecido
 * (0,842) son la misma pregunta con otras palabras. No existe el umbral: estos
 * modelos codifican el TEMA, y dos preguntas del mismo tema comparten casi todo
 * el vector aunque pidan cosas opuestas.
 *
 * Así que el vector hace lo único que sabe hacer bien —traer candidatos
 * baratos— y quién decide si son el mismo hueco es el generador, con la
 * pregunta delante. Exactamente el reparto que ya usa la abstención.
 */

export type GapReason = "BELOW_THRESHOLD" | "MODEL_ABSTAINED" | "GROUNDING_FAILED";

/**
 * Umbral de CANDIDATOS, no de decisión.
 *
 * Está puesto por debajo del equivalente peor medido (0,842) a propósito: aquí
 * el error caro es dejar fuera al hueco correcto, porque lo que no llega a la
 * lista el generador no lo puede elegir. Los falsos positivos no cuestan nada:
 * los descarta él.
 */
export const GAP_CANDIDATE_THRESHOLD = 0.8;

/** Cuántos candidatos se le ponen delante. Más no mejora y alarga el prompt. */
export const GAP_CANDIDATE_LIMIT = 5;

/**
 * Cuántas formulaciones distintas se guardan por hueco.
 *
 * Es una muestra para que quien lo lea vea CÓMO se lo preguntan —el vocabulario
 * del cliente, que casi nunca es el del manual—, no un registro de todo.
 */
export const MAX_VARIANTS = 10;

export interface GapInput {
  tenantId: string;
  question: string;
  reason: GapReason;
}

export interface GapCandidate {
  id: string;
  question: string;
  variants: string[];
  similarity: number;
}

/** Decide si la pregunta nueva es alguno de los huecos candidatos. */
export type GapMatcher = (
  question: string,
  candidates: GapCandidate[],
) => Promise<string | null>;

export interface GapResult {
  gapId: string;
  grouped: boolean;
  occurrences: number;
  /** Cuántos candidatos se le ofrecieron al decisor. Útil para diagnosticar. */
  candidatesConsidered: number;
}

export interface GapDeps {
  embedder: EmbeddingProvider;
  /** Normalmente `withRlsTransaction`. Se inyecta para poder testear. */
  transaction: <T>(fn: (tx: PrismaNS.TransactionClient) => Promise<T>) => Promise<T>;
  /**
   * Quién decide si dos preguntas son el mismo hueco.
   *
   * Opcional: sin decisor **no se agrupa**, y cada abstención abre su propia
   * fila. Es peor informe pero no es un dato perdido — y es mejor que agrupar
   * con un umbral que la medición dice que no existe.
   */
  match?: GapMatcher;
}

/**
 * Registra un hueco.
 *
 * En fases, y por el mismo motivo que la ingesta: **el trabajo lento no puede
 * vivir dentro de una transacción**. Embeber y preguntarle al generador son
 * llamadas de red o de CPU que mantendrían una conexión del pool bloqueada
 * durante segundos.
 *
 *   1. Embeber — fuera de transacción
 *   2. Transacción corta: traer candidatos por vector
 *   3. Decidir — fuera de transacción, es lo lento
 *   4. Transacción corta: agrupar o crear
 */
export async function recordGap(
  input: GapInput,
  deps: GapDeps,
): Promise<GapResult> {
  const question = input.question.trim();
  const embedding = await embedQuery(deps.embedder, question);
  const column = columnForDimensions(deps.embedder.dimensions);
  const vector = `[${embedding.join(",")}]`;

  const candidates = await deps.transaction((tx) =>
    findCandidates(tx, input.tenantId, deps.embedder, column, vector),
  );

  const matchId =
    candidates.length > 0 && deps.match !== undefined
      ? await deps.match(question, candidates)
      : null;

  // Un id que no estaba entre los candidatos es un id inventado. Se descarta en
  // vez de confiar: es la misma comprobación que se le hace a una cita.
  const matched = candidates.find((c) => c.id === matchId);

  if (matched !== undefined) {
    const updated = await deps.transaction((tx) =>
      tx.knowledgeGap.update({
        where: { id: matched.id },
        data: {
          occurrences: { increment: 1 },
          lastSeenAt: new Date(),
          variants: nextVariants(matched, question),
        },
        select: { occurrences: true },
      }),
    );

    return {
      gapId: matched.id,
      grouped: true,
      occurrences: updated.occurrences,
      candidatesConsidered: candidates.length,
    };
  }

  const created = await deps.transaction(async (tx) => {
    const row = await tx.knowledgeGap.create({
      data: {
        tenantId: input.tenantId,
        question,
        variants: [],
        reason: input.reason,
        embeddingProvider: deps.embedder.id,
        embeddingDimensions: deps.embedder.dimensions,
      },
      select: { id: true },
    });

    // El vector va por SQL crudo: Prisma no sabe escribir la columna `vector`,
    // igual que con los fragmentos.
    await tx.$executeRaw`
      UPDATE "knowledgeGap"
      SET ${Prisma.raw(`"${column}"`)} = ${vector}::vector
      WHERE id = ${row.id}
    `;

    return row;
  });

  return {
    gapId: created.id,
    grouped: false,
    occurrences: 1,
    candidatesConsidered: candidates.length,
  };
}

/**
 * Trae los huecos abiertos más cercanos.
 *
 * Solo ABIERTOS: uno ya documentado no debe absorber preguntas nuevas. Si
 * vuelve a preguntarse algo que ya se documentó, eso es una señal distinta —la
 * documentación existe y no se está encontrando— y merece fila propia en vez de
 * esconderse dentro de la anterior.
 *
 * Y solo del mismo proveedor y dimensión: comparar vectores de proveedores
 * distintos no significa nada.
 */
async function findCandidates(
  tx: PrismaNS.TransactionClient,
  tenantId: string,
  embedder: Pick<EmbeddingProvider, "id" | "dimensions">,
  column: string,
  vector: string,
): Promise<GapCandidate[]> {
  const rows = await tx.$queryRaw<
    { id: string; question: string; variants: string[]; similarity: number }[]
  >`
    SELECT id, question, variants,
           1 - (${Prisma.raw(`"${column}"`)} <=> ${vector}::vector) AS similarity
    FROM "knowledgeGap"
    WHERE "tenantId" = ${tenantId}
      AND status = 'OPEN'
      AND "embeddingProvider" = ${embedder.id}
      AND "embeddingDimensions" = ${embedder.dimensions}
      AND ${Prisma.raw(`"${column}"`)} IS NOT NULL
    ORDER BY ${Prisma.raw(`"${column}"`)} <=> ${vector}::vector
    LIMIT ${GAP_CANDIDATE_LIMIT}
  `;

  return rows.filter((row) => row.similarity >= GAP_CANDIDATE_THRESHOLD);
}

/**
 * Añade la formulación nueva si aporta algo.
 *
 * No se guarda una idéntica a la representativa ni repetida: el valor de esta
 * lista es enseñar el vocabulario del cliente, y diez copias de la misma frase
 * no enseñan nada.
 */
function nextVariants(candidate: GapCandidate, question: string): string[] {
  if (question === candidate.question.trim()) return candidate.variants;
  if (candidate.variants.includes(question)) return candidate.variants;
  if (candidate.variants.length >= MAX_VARIANTS) return candidate.variants;
  return [...candidate.variants, question];
}
