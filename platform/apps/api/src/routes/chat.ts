import type { FastifyInstance } from "fastify";

import { withRlsTransaction, type Prisma } from "@platform/db";
import { publish } from "@platform/events";
import {
  answerFromKnowledge,
  embedQuery,
  hybridSearch,
  passesThreshold,
  resolveQuestion,
  DEFAULT_SIMILARITY_THRESHOLD,
  type ConversationTurn,
} from "@platform/knowledge";
import { recordUsage, usageFromGeneration } from "@platform/observability";
import {
  createAIProvider,
  createEmbeddingProvider,
  type AIProvider,
  type EmbeddingProvider,
} from "@platform/providers";

import { requireScope } from "../auth.js";
import { ApiError } from "../errors.js";
import { readInTenant, withTenant } from "../server.js";

/**
 * `/v1/chat` (§27).
 *
 * **El chat es una interfaz del motor, no el motor.** Esta ruta no decide nada
 * sobre la calidad de la respuesta: ensambla `resolveQuestion` y
 * `answerFromKnowledge`, que es lo que mide el arnés. Lo único que añade es
 * continuidad —el hilo— y el archivo de lo dicho.
 *
 * Si algún día hay que elegir entre "esto mejora el chat" y "esto respeta la
 * arquitectura", gana la arquitectura: es la regla de núcleo del proyecto.
 */

const CHAT_BODY = {
  type: "object",
  required: ["message"],
  additionalProperties: false,
  properties: {
    message: { type: "string", minLength: 1, maxLength: 4_000 },
    /** Continuar un hilo existente. */
    conversationId: { type: "string" },
    /** O identificarlo por canal, que es como lo hace una integración. */
    channel: { type: "string", enum: ["API", "WEB", "WHATSAPP", "EMAIL", "SLACK"] },
    externalId: { type: "string", maxLength: 200 },
    externalUserId: { type: "string", maxLength: 200 },
  },
} as const;

interface ChatBody {
  message: string;
  conversationId?: string;
  channel?: "API" | "WEB" | "WHATSAPP" | "EMAIL" | "SLACK";
  externalId?: string;
  externalUserId?: string;
}

/** Cuántos mensajes previos se cargan para dar continuidad. */
const HISTORY_LIMIT = 10;

export async function registerChatRoutes(
  app: FastifyInstance,
  injected: { ai?: AIProvider; embedding?: EmbeddingProvider } = {},
): Promise<void> {
  let embedder = injected.embedding;
  let generator = injected.ai;
  const getEmbedder = (): EmbeddingProvider => (embedder ??= createEmbeddingProvider());
  const getGenerator = (): AIProvider => (generator ??= createAIProvider());

  app.post<{ Body: ChatBody }>(
    "/v1/chat",
    { schema: { body: CHAT_BODY } },
    async (request, reply) => {
      requireScope(request.apiKey, "chat:write");

      const { message, conversationId, channel, externalId, externalUserId } =
        request.body;
      const tenantId = request.tenantCtx.tenantId;

      const conversation = await readInTenant(request.tenantCtx, (tx) =>
        openConversation(tx, tenantId, {
          ...(conversationId === undefined ? {} : { conversationId }),
          channel: channel ?? "API",
          ...(externalId === undefined ? {} : { externalId }),
          ...(externalUserId === undefined ? {} : { externalUserId }),
        }),
      );

      // Escalada a una persona: el bot se calla. Seguir contestando encima de
      // alguien que ya está atendiendo es peor que no responder.
      if (conversation.status === "ESCALATED") {
        throw new ApiError(
          409,
          "conversation_escalated",
          "Esta conversación está atendida por una persona.",
        );
      }
      if (conversation.status === "CLOSED") {
        throw new ApiError(409, "conversation_closed", "Esta conversación está cerrada.");
      }

      const history = await readInTenant(request.tenantCtx, (tx) =>
        recentTurns(tx, conversation.id),
      );

      const policy = await readInTenant(request.tenantCtx, (tx) =>
        loadPolicy(tx, tenantId),
      );

      // Aquí está la única decisión de calidad del chat, y no la toma el chat:
      // "¿y a Canarias?" no recupera nada, así que se reescribe antes de
      // buscar.
      const resolved = await withTenant(request.tenantCtx, () =>
        resolveQuestion({
          tenantId,
          question: message,
          history,
          provider: getGenerator(),
        }),
      );

      const hits = await withTenant(request.tenantCtx, async () => {
        const queryEmbedding = await embedQuery(getEmbedder(), resolved.question);
        return withRlsTransaction((tx) =>
          hybridSearch(tx, {
            tenantId,
            queryText: resolved.question,
            queryEmbedding,
            limit: 8,
          }),
        );
      });

      const belowThreshold = !passesThreshold(hits, policy.groundingThreshold);

      const result = belowThreshold
        ? undefined
        : await withTenant(request.tenantCtx, () =>
            answerFromKnowledge({
              tenantId,
              question: resolved.question,
              hits,
              provider: getGenerator(),
              fallbackMessage: policy.fallbackMessage,
              rules: policy.rules,
              prohibitions: policy.prohibitions,
              temperature: policy.temperature,
            }),
          );

      const answer = result?.answer ?? {
        answered: false,
        response: policy.fallbackMessage,
        citations: [],
      };

      const saved = await readInTenant(request.tenantCtx, async (tx) => {
        // Los dos mensajes y el contador, en la MISMA transacción. Guardar la
        // pregunta y perder la respuesta deja un hilo que dice que el cliente
        // preguntó y el sistema no contestó nunca.
        await tx.message.create({
          data: {
            tenantId,
            conversationId: conversation.id,
            role: "USER",
            content: message,
            ...(resolved.rewritten ? { resolvedQuestion: resolved.question } : {}),
          },
        });

        const assistant = await tx.message.create({
          data: {
            tenantId,
            conversationId: conversation.id,
            role: "ASSISTANT",
            content: answer.response,
            answered: answer.answered,
            citations: answer.citations as unknown as Prisma.InputJsonValue,
            degraded: result?.degraded ?? false,
            ...(result === undefined ? {} : { model: result.model }),
            ...(result === undefined ? {} : { latencyMs: result.latencyMs }),
            cost: (result?.cost ?? 0) + resolved.cost,
          },
          select: { id: true, createdAt: true },
        });

        await tx.conversation.update({
          where: { id: conversation.id },
          data: { messageCount: { increment: 2 }, lastMessageAt: new Date() },
        });

        await recordUsage(tx, tenantId, [
          { metric: "API_CALLS", quantity: 1 },
          { metric: "ANSWERS", quantity: 1 },
          { metric: "EMBEDDINGS", quantity: 1 },
          ...(result === undefined ? [] : usageFromGeneration(result)),
        ]);

        await publish(tx, {
          type: "message.received",
          tenantId,
          payload: { conversationId: conversation.id, channel: conversation.channel },
        });

        // Toda abstención es un hueco de conocimiento, venga del chat o de
        // /v1/knowledge/answer. La pregunta que se registra es la RESUELTA: es
        // la que de verdad no supo responder, y "¿y a Canarias?" en un informe
        // no le dice nada a nadie.
        const gap = gapFor(result, answer.answered, belowThreshold);
        if (gap !== undefined) {
          await publish(tx, {
            type: "knowledge.gap",
            tenantId,
            payload: { question: resolved.question, reason: gap },
          });
        }

        return assistant;
      });

      return reply.send({
        conversationId: conversation.id,
        messageId: saved.id,
        answered: answer.answered,
        response: answer.response,
        citations: answer.citations,
        meta: {
          generated: result !== undefined,
          degraded: result?.degraded ?? false,
          // Se dice en voz alta qué se buscó de verdad. Sin esto, depurar por
          // qué una respuesta salió rara en el tercer turno es adivinar.
          resolvedQuestion: resolved.rewritten ? resolved.question : null,
          ...(result === undefined ? {} : { model: result.model }),
        },
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/conversations/:id",
    async (request, reply) => {
      requireScope(request.apiKey, "chat:read");

      const conversation = await readInTenant(request.tenantCtx, (tx) =>
        tx.conversation.findUnique({
          where: { id: request.params.id },
          select: {
            id: true,
            channel: true,
            externalId: true,
            externalUserId: true,
            status: true,
            messageCount: true,
            lastMessageAt: true,
            createdAt: true,
            messages: {
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                role: true,
                content: true,
                answered: true,
                citations: true,
                degraded: true,
                resolvedQuestion: true,
                createdAt: true,
              },
            },
          },
        }),
      );

      // 404 y no 403: para este tenant, la conversación de otro no existe.
      if (conversation === null) {
        throw new ApiError(404, "not_found", `No existe la conversación ${request.params.id}.`);
      }

      return reply.send(conversation);
    },
  );

  app.post<{ Params: { id: string }; Body: { status: "OPEN" | "ESCALATED" | "CLOSED" } }>(
    "/v1/conversations/:id/status",
    {
      schema: {
        body: {
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["OPEN", "ESCALATED", "CLOSED"] },
          },
        },
      },
    },
    async (request, reply) => {
      requireScope(request.apiKey, "chat:write");

      const existing = await readInTenant(request.tenantCtx, (tx) =>
        tx.conversation.findUnique({
          where: { id: request.params.id },
          select: { id: true },
        }),
      );

      if (existing === null) {
        throw new ApiError(404, "not_found", `No existe la conversación ${request.params.id}.`);
      }

      const updated = await readInTenant(request.tenantCtx, (tx) =>
        tx.conversation.update({
          where: { id: existing.id },
          data: { status: request.body.status },
          select: { id: true, status: true },
        }),
      );

      return reply.send(updated);
    },
  );
}

/**
 * Localiza o abre el hilo.
 *
 * Por `conversationId` cuando el cliente lo lleva, o por canal + id externo,
 * que es como lo hace una integración: WhatsApp no sabe de nuestros ids, sabe
 * del número de teléfono. La unicidad compuesta evita que un reintento de
 * entrega del canal abra una conversación nueva.
 */
async function openConversation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  args: {
    conversationId?: string;
    channel: "API" | "WEB" | "WHATSAPP" | "EMAIL" | "SLACK";
    externalId?: string;
    externalUserId?: string;
  },
): Promise<{ id: string; status: string; channel: string }> {
  if (args.conversationId !== undefined) {
    const existing = await tx.conversation.findUnique({
      where: { id: args.conversationId },
      select: { id: true, status: true, channel: true },
    });

    if (existing === null) {
      throw new ApiError(404, "not_found", `No existe la conversación ${args.conversationId}.`);
    }
    return existing;
  }

  if (args.externalId !== undefined) {
    const existing = await tx.conversation.findFirst({
      where: { channel: args.channel, externalId: args.externalId },
      select: { id: true, status: true, channel: true },
    });
    if (existing !== null) return existing;
  }

  return tx.conversation.create({
    data: {
      tenantId,
      channel: args.channel,
      externalId: args.externalId ?? null,
      externalUserId: args.externalUserId ?? null,
    },
    select: { id: true, status: true, channel: true },
  });
}

/**
 * Los últimos turnos, en orden cronológico.
 *
 * Se piden los más RECIENTES y luego se invierten: pedir los primeros dejaría
 * al reescritor con el principio de una conversación larga, que es justo lo que
 * no necesita.
 */
async function recentTurns(
  tx: Prisma.TransactionClient,
  conversationId: string,
): Promise<ConversationTurn[]> {
  const messages = await tx.message.findMany({
    where: { conversationId, role: { in: ["USER", "ASSISTANT"] } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, content: true },
  });

  return messages
    .reverse()
    .map((m) => ({ role: m.role as "USER" | "ASSISTANT", content: m.content }));
}

interface Policy {
  groundingThreshold: number;
  fallbackMessage: string;
  temperature: number;
  rules: string[];
  prohibitions: string[];
}

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
    prohibitions: [...(dna?.neverDo ?? []), ...(dna?.legalBoundaries ?? [])],
  };
}

function gapFor(
  result: { degraded: boolean } | undefined,
  answered: boolean,
  belowThreshold: boolean,
): "BELOW_THRESHOLD" | "MODEL_ABSTAINED" | "GROUNDING_FAILED" | undefined {
  if (belowThreshold) return "BELOW_THRESHOLD";
  if (result?.degraded === true) return "GROUNDING_FAILED";
  if (!answered) return "MODEL_ABSTAINED";
  return undefined;
}
