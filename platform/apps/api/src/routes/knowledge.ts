import type { FastifyInstance } from "fastify";

import { withRlsTransaction, type Prisma } from "@platform/db";
import { publish } from "@platform/events";
import {
  answerFromKnowledge,
  embedQuery,
  hybridSearch,
  passesThreshold,
  DEFAULT_SIMILARITY_THRESHOLD,
  type GapReason,
  type RetrievalHit,
} from "@platform/knowledge";
import { recordUsage, usageFromGeneration } from "@platform/observability";
import {
  createAIProvider,
  createEmbeddingProvider,
  type AIProvider,
  type EmbeddingProvider,
} from "@platform/providers";

import { requireScope } from "../auth.js";
import { readInTenant, withTenant } from "../server.js";

/**
 * `/v1/knowledge/*` (§27).
 *
 * Estas rutas no tienen lógica propia: ensamblan lo que ya está medido en
 * `@platform/knowledge`. Es deliberado — el arnés de evaluación mide
 * `answerFromKnowledge`, y cualquier decisión que se tomara aquí sería una
 * decisión sin medir sirviéndose en producción.
 */

const SEARCH_BODY = {
  type: "object",
  required: ["query"],
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1, maxLength: 2_000 },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 8 },
    categories: { type: "array", items: { type: "string" }, maxItems: 20 },
  },
} as const;

const ANSWER_BODY = {
  type: "object",
  required: ["question"],
  additionalProperties: false,
  properties: {
    question: { type: "string", minLength: 1, maxLength: 2_000 },
    limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
    categories: { type: "array", items: { type: "string" }, maxItems: 20 },
  },
} as const;

interface SearchBody {
  query: string;
  limit?: number;
  categories?: string[];
}

interface AnswerBody {
  question: string;
  limit?: number;
  categories?: string[];
}

export async function registerKnowledgeRoutes(
  app: FastifyInstance,
  injected: { ai?: AIProvider; embedding?: EmbeddingProvider } = {},
): Promise<void> {
  // Perezosos y compartidos: construir el proveedor de embeddings carga un
  // modelo de 120 MB, y hacerlo por petición sería insostenible. Construirlo al
  // arrancar impediría levantar la API para servir solo búsqueda cuando el
  // generador no está configurado.
  let embedder = injected.embedding;
  let generator = injected.ai;

  const getEmbedder = (): EmbeddingProvider => (embedder ??= createEmbeddingProvider());
  const getGenerator = (): AIProvider => (generator ??= createAIProvider());

  app.post<{ Body: SearchBody }>(
    "/v1/knowledge/search",
    { schema: { body: SEARCH_BODY } },
    async (request, reply) => {
      requireScope(request.apiKey, "knowledge:read");

      const { query, limit = 8, categories } = request.body;

      const hits = await withTenant(request.tenantCtx, async () => {
        const queryEmbedding = await embedQuery(getEmbedder(), query);
        return withRlsTransaction((tx) =>
          hybridSearch(tx, {
            // Del contexto de la credencial, jamás del cuerpo.
            tenantId: request.tenantCtx.tenantId,
            queryText: query,
            queryEmbedding,
            limit,
            ...(categories === undefined ? {} : { categories }),
          }),
        );
      });

      await meter(request.tenantCtx.tenantId, [
        { metric: "API_CALLS", quantity: 1 },
        { metric: "SEARCHES", quantity: 1 },
        { metric: "EMBEDDINGS", quantity: 1 },
      ]);

      return reply.send({ results: hits.map(publicHit) });
    },
  );

  app.post<{ Body: AnswerBody }>(
    "/v1/knowledge/answer",
    { schema: { body: ANSWER_BODY } },
    async (request, reply) => {
      requireScope(request.apiKey, "knowledge:answer");

      const { question, limit = 8, categories } = request.body;
      const tenantId = request.tenantCtx.tenantId;

      const policy = await readInTenant(request.tenantCtx, (tx) => loadPolicy(tx, tenantId));

      const hits = await withTenant(request.tenantCtx, async () => {
        const queryEmbedding = await embedQuery(getEmbedder(), question);
        return withRlsTransaction((tx) =>
          hybridSearch(tx, {
            tenantId,
            queryText: question,
            queryEmbedding,
            limit,
            ...(categories === undefined ? {} : { categories }),
          }),
        );
      });

      // Capa 1 del grounding: por debajo del umbral NO se genera. Un modelo que
      // no ve la pregunta no puede inventar la respuesta, y la abstención sale
      // gratis.
      if (!passesThreshold(hits, policy.groundingThreshold)) {
        await meter(
          tenantId,
          [
            { metric: "API_CALLS", quantity: 1 },
            { metric: "ANSWERS", quantity: 1 },
            { metric: "EMBEDDINGS", quantity: 1 },
          ],
          { question, reason: "BELOW_THRESHOLD" },
        );

        return reply.send({
          answered: false,
          response: policy.fallbackMessage,
          citations: [],
          sources: [],
          meta: { generated: false, reason: "below_threshold" },
        });
      }

      const result = await withTenant(request.tenantCtx, () =>
        answerFromKnowledge({
          tenantId,
          question,
          hits,
          provider: getGenerator(),
          fallbackMessage: policy.fallbackMessage,
          rules: policy.rules,
          prohibitions: policy.prohibitions,
          temperature: policy.temperature,
        }),
      );

      await meter(
        tenantId,
        [
          { metric: "API_CALLS", quantity: 1 },
          { metric: "ANSWERS", quantity: 1 },
          { metric: "EMBEDDINGS", quantity: 1 },
          ...usageFromGeneration(result),
        ],
        // Toda abstención es un hueco, pero no todas significan lo mismo: que
        // el modelo se abstenga teniendo los fragmentos delante dice que hay
        // documentación cercana que no cubre el caso, y que la validación
        // tumbara la respuesta dice además que el modelo intentó rellenarlo.
        gapFor(result, question),
      );

      return reply.send({
        answered: result.answer.answered,
        response: result.answer.response,
        citations: result.answer.citations,
        // Las fuentes van aparte de las citas: la cita es el trozo exacto, y
        // esto es de dónde salió, que es lo que una interfaz enseña como enlace.
        sources: sourcesFor(result.answer.citations, hits),
        meta: {
          generated: true,
          // Se dice en voz alta que la respuesta del modelo fue descartada. Un
          // cliente que ve muchas de estas tiene un problema de calidad de
          // corpus, y ocultárselo se lo deja descubrir a él.
          degraded: result.degraded,
          model: result.model,
          latencyMs: result.latencyMs,
          promptVersions: result.promptVersions,
        },
      });
    },
  );
}

interface Policy {
  groundingThreshold: number;
  fallbackMessage: string;
  temperature: number;
  rules: string[];
  prohibitions: string[];
}

/**
 * Carga la configuración y el ADN del tenant.
 *
 * Un tenant sin configuración no es un error: es un tenant recién creado. Se
 * sirven los valores por defecto del sistema, y el umbral por defecto es la
 * constante CALIBRADA, no la de la columna — ver la migración 004.
 */
async function loadPolicy(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<Policy> {
  const [config, dna] = await Promise.all([
    tx.tenantAIConfig.findUnique({ where: { tenantId } }),
    tx.businessDNA.findUnique({ where: { tenantId } }),
  ]);

  return {
    groundingThreshold: config?.groundingThreshold ?? DEFAULT_SIMILARITY_THRESHOLD,
    fallbackMessage:
      config?.fallbackMessage ??
      "No tengo esa información en la documentación de la empresa.",
    temperature: config?.temperature ?? 0.2,
    rules: dna?.alwaysDo ?? [],
    // `neverDo` se valida DOS veces: viaja en el contexto y además se comprueba
    // contra la respuesta generada (§11.2). Una prohibición que solo vive en el
    // prompt es una prohibición que se incumple el día que el contexto es largo.
    prohibitions: [...(dna?.neverDo ?? []), ...(dna?.legalBoundaries ?? [])],
  };
}

/**
 * Registra consumo sin poder tumbar la respuesta.
 *
 * `recordUsage` publica en el outbox dentro de una transacción; si esa
 * transacción falla, lo que se pierde es una línea de contabilidad, no la
 * respuesta que el cliente ya tiene calculada.
 */
async function meter(
  tenantId: string,
  entries: Parameters<typeof recordUsage>[2],
  gap?: { question: string; reason: GapReason },
): Promise<void> {
  try {
    await withRlsTransaction(async (tx) => {
      await recordUsage(tx, tenantId, entries);

      // El hueco se publica en la MISMA transacción que la medición. Lo pesado
      // —embeber la pregunta y buscarle grupo— lo hace el worker: no lo paga
      // quien está esperando la respuesta, y menos en una abstención, que ya
      // es de por sí la petición más lenta.
      if (gap !== undefined) {
        await publish(tx, {
          type: "knowledge.gap",
          tenantId,
          payload: { question: gap.question, reason: gap.reason },
        });
      }
    });
  } catch {
    // Deliberadamente silencioso aquí; el fallo se ve en la traza.
  }
}

/**
 * Qué clase de hueco es esta respuesta, si es alguno.
 *
 * Una respuesta correcta no es un hueco. Una degradación sí, y de la peor
 * clase: significa que el corpus no sostenía la respuesta Y que el modelo lo
 * intentó igualmente.
 */
function gapFor(
  result: { answer: { answered: boolean }; degraded: boolean },
  question: string,
): { question: string; reason: GapReason } | undefined {
  if (result.degraded) return { question, reason: "GROUNDING_FAILED" };
  if (!result.answer.answered) return { question, reason: "MODEL_ABSTAINED" };
  return undefined;
}

/** Lo que sale por la API. El vector y los rangos internos no salen. */
function publicHit(hit: RetrievalHit): Record<string, unknown> {
  return {
    chunkId: hit.chunkId,
    documentId: hit.documentId,
    content: hit.content,
    title: hit.title,
    sourceRef: hit.sourceRef,
    breadcrumbs: hit.breadcrumbs,
    pageNumber: hit.pageNumber,
    score: hit.score,
    matchedBy: hit.matchedBy,
  };
}

function sourcesFor(
  citations: { chunkId: string }[],
  hits: RetrievalHit[],
): Record<string, unknown>[] {
  const byId = new Map(hits.map((hit) => [hit.chunkId, hit]));
  const seen = new Set<string>();
  const sources: Record<string, unknown>[] = [];

  for (const citation of citations) {
    const hit = byId.get(citation.chunkId);
    if (hit === undefined || seen.has(hit.documentId)) continue;
    seen.add(hit.documentId);
    sources.push({
      documentId: hit.documentId,
      title: hit.title,
      sourceRef: hit.sourceRef,
      breadcrumbs: hit.breadcrumbs,
      pageNumber: hit.pageNumber,
    });
  }

  return sources;
}
