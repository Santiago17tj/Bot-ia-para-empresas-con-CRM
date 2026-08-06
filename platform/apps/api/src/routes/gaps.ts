import type { FastifyInstance } from "fastify";

import { requireScope } from "../auth.js";
import { ApiError } from "../errors.js";
import { readInTenant } from "../server.js";

/**
 * `/v1/knowledge/gaps` — qué le preguntan a la empresa que no sabe responder.
 *
 * Es la mitad que convierte la abstención en producto. Abstenerse bien evita el
 * daño; enseñar el hueco genera valor: «37 clientes han preguntado por
 * financiación este mes y no está documentado en ningún sitio».
 *
 * Se ordena por número de veces y no por fecha a propósito. Lo último que
 * preguntó alguien es una anécdota; lo que preguntan treinta es una decisión de
 * negocio, y el orden de la lista es lo que dirige el trabajo de quien la lee.
 */

const LIST_QUERY = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["OPEN", "DOCUMENTED", "DISMISSED"] },
    reason: {
      type: "string",
      enum: ["BELOW_THRESHOLD", "MODEL_ABSTAINED", "GROUNDING_FAILED"],
    },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  },
} as const;

const UPDATE_BODY = {
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["OPEN", "DOCUMENTED", "DISMISSED"] },
    resolvedByDocumentId: { type: "string" },
  },
} as const;

type GapStatus = "OPEN" | "DOCUMENTED" | "DISMISSED";
type GapReason = "BELOW_THRESHOLD" | "MODEL_ABSTAINED" | "GROUNDING_FAILED";

interface ListQuery {
  status?: GapStatus;
  reason?: GapReason;
  limit?: number;
}

interface UpdateBody {
  status: GapStatus;
  resolvedByDocumentId?: string;
}

export async function registerGapRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListQuery }>(
    "/v1/knowledge/gaps",
    { schema: { querystring: LIST_QUERY } },
    async (request, reply) => {
      requireScope(request.apiKey, "knowledge:read");

      const { status = "OPEN", reason, limit = 50 } = request.query;

      const gaps = await readInTenant(request.tenantCtx, (tx) =>
        tx.knowledgeGap.findMany({
          where: { status, ...(reason === undefined ? {} : { reason }) },
          orderBy: [{ occurrences: "desc" }, { lastSeenAt: "desc" }],
          take: limit,
          select: {
            id: true,
            question: true,
            variants: true,
            occurrences: true,
            reason: true,
            status: true,
            firstSeenAt: true,
            lastSeenAt: true,
            resolvedByDocumentId: true,
          },
        }),
      );

      return reply.send({
        gaps: gaps.map((gap) => ({
          id: gap.id,
          question: gap.question,
          // Cómo se lo preguntan de verdad. Casi nunca con el vocabulario del
          // manual, y esa diferencia es media respuesta a por qué no se
          // encontraba.
          variants: gap.variants,
          occurrences: gap.occurrences,
          reason: gap.reason,
          status: gap.status,
          firstSeenAt: gap.firstSeenAt,
          lastSeenAt: gap.lastSeenAt,
          resolvedByDocumentId: gap.resolvedByDocumentId,
        })),
      });
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateBody }>(
    "/v1/knowledge/gaps/:id",
    { schema: { body: UPDATE_BODY } },
    async (request, reply) => {
      // Cerrar un hueco cambia lo que el sistema considera pendiente, así que
      // pide escritura. Leer la lista no.
      requireScope(request.apiKey, "knowledge:write");

      const { status, resolvedByDocumentId } = request.body;

      const existing = await readInTenant(request.tenantCtx, (tx) =>
        tx.knowledgeGap.findUnique({
          where: { id: request.params.id },
          select: { id: true },
        }),
      );

      // 404 y no 403: para este tenant, un hueco de otro no existe.
      if (existing === null) {
        throw new ApiError(404, "not_found", `No existe el hueco ${request.params.id}.`);
      }

      const updated = await readInTenant(request.tenantCtx, (tx) =>
        tx.knowledgeGap.update({
          where: { id: request.params.id },
          data: {
            status,
            // `resolvedAt` lo pone el servidor, no el cliente: es un dato de
            // auditoría y aceptarlo de fuera lo convierte en un campo que se
            // puede falsear.
            resolvedAt: status === "OPEN" ? null : new Date(),
            resolvedByDocumentId: resolvedByDocumentId ?? null,
          },
          select: { id: true, status: true, resolvedAt: true },
        }),
      );

      return reply.send(updated);
    },
  );
}
