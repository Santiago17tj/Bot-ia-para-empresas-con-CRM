import { Prisma } from "@platform/db";

import { columnForDimensions } from "./dimensions.js";

/**
 * Recuperación híbrida (§5.6 / §7.5 del plan): vectorial + léxica, fusionadas
 * con RRF.
 */

export interface RetrievalHit {
  chunkId: string;
  documentId: string;
  versionId: string;
  content: string;
  title: string | null;
  sourceRef: string | null;
  breadcrumbs: string[];
  pageNumber: number | null;
  tokenCount: number;
  /** Puntuación fusionada. Comparable entre consultas, no interpretable como probabilidad. */
  score: number;
  /** De dónde vino: útil para diagnosticar por qué se recuperó algo. */
  matchedBy: ("vector" | "lexical")[];
  vectorRank: number | null;
  lexicalRank: number | null;
  /**
   * Similitud coseno con la consulta, de 0 a 1. Solo si entró por la rama
   * vectorial.
   *
   * Es lo que se umbraliza para decidir si hay material suficiente — NO la
   * puntuación RRF. RRF vale para ordenar: su valor depende solo de k y de la
   * posición, así que  es el techo de una rama y no dice
   * NADA sobre si el fragmento se parece a la pregunta. Umbralizarlo exige de
   * hecho que el resultado aparezca en las dos ramas, y eso descarta cualquier
   * coincidencia puramente semántica.
   */
  vectorSimilarity: number | null;
}

export interface RetrievalOptions {
  tenantId: string;
  queryText: string;
  queryEmbedding: number[];
  limit?: number;
  /** Cuántos candidatos pide cada rama antes de fusionar. */
  candidatesPerBranch?: number;
  language?: string;
  /** Filtra por categorías de documento, si la receta lo pide. */
  categories?: string[];
}

interface RawHit {
  id: string;
  versionId: string;
  documentId: string;
  content: string;
  title: string | null;
  sourceRef: string | null;
  breadcrumbs: string[];
  pageNumber: number | null;
  tokenCount: number;
  rank: number;
}

/** Constante estándar de RRF. Amortigua el peso de los primeros puestos. */
const RRF_K = 60;

/**
 * Fusión Reciprocal Rank: `score = Σ 1/(k + rank)`.
 *
 * Se fusiona por POSICIÓN, no por puntuación, y eso es lo que la hace robusta:
 * la distancia coseno y `ts_rank` viven en escalas distintas e incomparables, y
 * normalizarlas exigiría calibrar pesos a mano para cada corpus. Con RRF, que
 * una rama devuelva basura solo significa que sus posiciones aportan poco.
 */
export function fuseRRF(
  vector: RawHit[],
  lexical: RawHit[],
  limit: number,
): RetrievalHit[] {
  const byId = new Map<string, RetrievalHit>();

  const merge = (hits: RawHit[], branch: "vector" | "lexical"): void => {
    hits.forEach((hit, index) => {
      const rank = index + 1;
      const existing = byId.get(hit.id);
      const contribution = 1 / (RRF_K + rank);

      if (existing === undefined) {
        byId.set(hit.id, {
          chunkId: hit.id,
          documentId: hit.documentId,
          versionId: hit.versionId,
          content: hit.content,
          title: hit.title,
          sourceRef: hit.sourceRef,
          breadcrumbs: hit.breadcrumbs,
          pageNumber: hit.pageNumber,
          tokenCount: hit.tokenCount,
          score: contribution,
          matchedBy: [branch],
          vectorRank: branch === "vector" ? rank : null,
          lexicalRank: branch === "lexical" ? rank : null,
          // rank de la rama vectorial ES la distancia coseno (0 = idéntico).
          vectorSimilarity: branch === "vector" ? 1 - hit.rank : null,
        });
        return;
      }

      existing.score += contribution;
      existing.matchedBy.push(branch);
      if (branch === "vector") {
        existing.vectorRank = rank;
        existing.vectorSimilarity = 1 - hit.rank;
      } else {
        existing.lexicalRank = rank;
      }
    });
  };

  merge(vector, "vector");
  merge(lexical, "lexical");

  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Rama vectorial: similitud coseno sobre el índice HNSW.
 *
 * `<=>` es distancia, no similitud: menor es mejor, por eso el orden es
 * ascendente. Confundirlo devuelve exactamente los peores resultados con total
 * naturalidad.
 */
async function vectorBranch(
  tx: Prisma.TransactionClient,
  opts: Required<Pick<RetrievalOptions, "queryEmbedding" | "candidatesPerBranch">>,
): Promise<RawHit[]> {
  const literal = `[${opts.queryEmbedding.join(",")}]`;

  // La columna sale de la dimensión de la consulta, igual que en la ingesta.
  // Es lo que permite que convivan dos proveedores durante una migración: cada
  // consulta mira solo los vectores de su propio espacio. Comparar vectores de
  // modelos distintos daría resultados plausibles y equivocados sin fallar.
  const column = Prisma.raw(`"${columnForDimensions(opts.queryEmbedding.length)}"`);

  return tx.$queryRaw<RawHit[]>`
    SELECT c.id,
           c."versionId",
           v."documentId",
           c.content,
           c.title,
           d."sourceRef",
           c.breadcrumbs,
           c."pageNumber",
           c."tokenCount",
           (c.${column} <=> ${literal}::vector) AS rank
    FROM "chunk" c
    JOIN "documentVersion" v ON v.id = c."versionId"
    JOIN "document" d        ON d.id = v."documentId"
    WHERE c."isActive"
      AND v."isActive"
      AND d."isActive"
      AND c.${column} IS NOT NULL
      AND (d."effectiveFrom" IS NULL OR d."effectiveFrom" <= now())
      AND (d."expiresAt"     IS NULL OR d."expiresAt"     >  now())
    ORDER BY c.${column} <=> ${literal}::vector
    LIMIT ${opts.candidatesPerBranch}
  `;
}

/**
 * Rama léxica: BM25 sobre el índice GIN.
 *
 * Captura lo que la vectorial falla con seguridad: referencias, SKUs y siglas.
 * `AX-4402` y `AX-4403` son casi idénticos como vectores; para BM25 son
 * términos distintos.
 */
async function lexicalBranch(
  tx: Prisma.TransactionClient,
  opts: Required<Pick<RetrievalOptions, "queryText" | "candidatesPerBranch" | "language">>,
): Promise<RawHit[]> {
  const config = opts.language === "en" ? "english" : "spanish";

  return tx.$queryRaw<RawHit[]>`
    SELECT c.id,
           c."versionId",
           v."documentId",
           c.content,
           c.title,
           d."sourceRef",
           c.breadcrumbs,
           c."pageNumber",
           c."tokenCount",
           ts_rank(c.search_vector, websearch_to_tsquery(${config}::regconfig, ${opts.queryText})) AS rank
    FROM "chunk" c
    JOIN "documentVersion" v ON v.id = c."versionId"
    JOIN "document" d        ON d.id = v."documentId"
    WHERE c."isActive"
      AND v."isActive"
      AND d."isActive"
      AND c.search_vector @@ websearch_to_tsquery(${config}::regconfig, ${opts.queryText})
      AND (d."effectiveFrom" IS NULL OR d."effectiveFrom" <= now())
      AND (d."expiresAt"     IS NULL OR d."expiresAt"     >  now())
    ORDER BY rank DESC
    LIMIT ${opts.candidatesPerBranch}
  `;
}

/**
 * Recuperación híbrida completa.
 *
 * Debe llamarse DENTRO de `withRlsTransaction`, para que las políticas de
 * Postgres filtren por tenant. El `tenantId` de las opciones se usa para la
 * traza, no como filtro: si esta consulta dependiera de un `WHERE tenantId`
 * escrito a mano, olvidarlo sería una fuga; con RLS, olvidarlo no devuelve
 * nada.
 */
export async function hybridSearch(
  tx: Prisma.TransactionClient,
  opts: RetrievalOptions,
): Promise<RetrievalHit[]> {
  const limit = opts.limit ?? 8;
  const candidates = opts.candidatesPerBranch ?? 20;
  const language = opts.language ?? "es";

  // Las dos ramas son independientes: en paralelo cuestan lo que la más lenta.
  const [vector, lexical] = await Promise.all([
    vectorBranch(tx, { queryEmbedding: opts.queryEmbedding, candidatesPerBranch: candidates }),
    lexicalBranch(tx, {
      queryText: opts.queryText,
      candidatesPerBranch: candidates,
      language,
    }),
  ]);

  return fuseRRF(vector, lexical, limit);
}

/**
 * ¿Supera algún resultado el umbral para invocar al generador?
 *
 * Es la CAPA 1 del grounding, y la más fuerte de las seis: un modelo que no ve
 * la pregunta no puede inventar la respuesta. Todas las demás capas actúan
 * sobre una generación que ya ocurrió; esta impide que ocurra.
 */
/**
 * Umbral por defecto, MEDIDO — no elegido a ojo.
 *
 * Calibración sobre multilingual-e5-small con un corpus de atención al cliente
 * (packages/eval/scripts/calibrate.mjs):
 *
 *   respondibles     0,853 – 0,927
 *   sin respuesta    0,775 – 0,846
 *   hueco                    0,0075
 *
 * Siete milésimas de separación. Ese número es el hallazgo, y dice algo que
 * conviene no olvidar: **la similitud coseno sola es una señal DÉBIL de
 * abstención con estos modelos.** Los e5 comprimen todo en una banda alta y
 * estrecha, así que un umbral afinado al hueco funciona con el conjunto medido
 * y se rompe con la pregunta siguiente.
 *
 * Por eso el valor por defecto es CONSERVADOR: descarta lo que no se parece a
 * nada (una receta de cocina puntúa 0,77) y deja pasar el resto. Filtra el
 * disparate, no decide la abstención.
 *
 * La abstención de verdad la deciden las capas 4–6: salida estructurada con
 * citas obligatorias y validación en código. El modelo recibe los fragmentos,
 * ve que no contestan y devuelve `answered: false`. Subir este umbral para
 * intentar que haga ese trabajo produce sobreabstención — se calla cosas que
 * sabe — sin evitar una sola invención.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.78;

export function passesThreshold(hits: RetrievalHit[], threshold: number): boolean {
  // Se mira el mejor de TODOS, no solo el primero: la fusión puede colocar
  // arriba un resultado léxico fuerte cuya similitud semántica sea menor que
  // la de otro más abajo.
  const best = hits.reduce(
    (max, hit) => Math.max(max, hit.vectorSimilarity ?? 0),
    0,
  );
  return best >= threshold;
}
