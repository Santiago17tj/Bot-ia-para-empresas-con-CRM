import type { FastifyInstance } from "fastify";

import type { Prisma } from "@platform/db";
import { publish } from "@platform/events";
import {
  ConnectorError,
  availableConnectors,
  connectorFor,
  parseCron,
} from "@platform/connectors";

import {
  encryptConfigSecrets,
  redactSecrets,
  secretsReady,
  SecretsError,
} from "@platform/secrets";

import { requireScope } from "../auth.js";
import { ApiError } from "../errors.js";
import { readInTenant } from "../server.js";

/**
 * `/v1/sources` — orígenes de conocimiento que se sincronizan solos (§7, §27).
 *
 * Es la diferencia entre subir ficheros a mano —que no pasa de una demo— y que
 * el conocimiento de la empresa esté siempre al día sin que nadie se acuerde de
 * actualizarlo. Por la regla de núcleo del proyecto, esto es lo más núcleo que
 * hay: cuanto más se sincroniza solo, más depende la empresa de la plataforma.
 *
 * La sincronización es **asíncrona**, por lo mismo que la ingesta: rastrear un
 * sitio son decenas de peticiones con pausa entre ellas, y eso no cabe en un
 * timeout HTTP. Se responde 202 y el worker trabaja.
 */

const CREATE_BODY = {
  type: "object",
  required: ["name", "kind", "config"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    kind: { type: "string", enum: ["URL", "SITEMAP"] },
    config: { type: "object" },
    // Cron. Null o ausente = solo manual.
    syncSchedule: { type: ["string", "null"], maxLength: 100 },
  },
} as const;

const UPDATE_BODY = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    config: { type: "object" },
    syncSchedule: { type: ["string", "null"], maxLength: 100 },
    isActive: { type: "boolean" },
  },
} as const;

interface CreateBody {
  name: string;
  kind: "URL" | "SITEMAP";
  config: Record<string, unknown>;
  syncSchedule?: string | null;
}

interface UpdateBody {
  name?: string;
  config?: Record<string, unknown>;
  syncSchedule?: string | null;
  isActive?: boolean;
}

export async function registerSourceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/sources", async (request, reply) => {
    requireScope(request.apiKey, "knowledge:read");

    const sources = await readInTenant(request.tenantCtx, (tx) =>
      tx.knowledgeSource.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          kind: true,
          config: true,
          syncSchedule: true,
          lastSyncAt: true,
          lastSyncStatus: true,
          lastSyncError: true,
          isActive: true,
          createdAt: true,
          _count: { select: { documents: true } },
        },
      }),
    );

    return reply.send({
      sources: sources.map((source) => ({
        id: source.id,
        name: source.name,
        kind: source.kind,
        // Redactada SIEMPRE. Los secretos no salen por API ni cifrados (§28):
        // publicar un texto cifrado es publicar algo que solo depende de una
        // clave, y las claves se filtran. El conector declara qué campos lo son;
        // esta capa no necesita saber de qué van.
        config: publicConfig(source.kind, source.config),
        syncSchedule: source.syncSchedule,
        lastSyncAt: source.lastSyncAt,
        lastSyncStatus: source.lastSyncStatus,
        lastSyncError: source.lastSyncError,
        isActive: source.isActive,
        documents: source._count.documents,
        createdAt: source.createdAt,
      })),
      availableKinds: availableConnectors(),
    });
  });

  app.post<{ Body: CreateBody }>(
    "/v1/sources",
    { schema: { body: CREATE_BODY } },
    async (request, reply) => {
      requireScope(request.apiKey, "knowledge:write");

      const { name, kind, config, syncSchedule } = request.body;

      // Se valida ANTES de guardar. Una fuente mal configurada que se acepta al
      // crearla falla la primera noche que sincroniza, cuando nadie mira.
      const validated = validateOrFail(kind, config);
      assertValidSchedule(syncSchedule);
      const stored = encryptOrFail(kind, validated, {}, request.tenantCtx.tenantId);

      const source = await readInTenant(request.tenantCtx, (tx) =>
        tx.knowledgeSource.create({
          data: {
            tenantId: request.tenantCtx.tenantId,
            name,
            kind,
            config: stored as Prisma.InputJsonValue,
            syncSchedule: syncSchedule ?? null,
          },
          select: { id: true, name: true, kind: true, config: true, createdAt: true },
        }),
      );

      return reply.status(201).send({
        ...source,
        config: publicConfig(source.kind, source.config),
      });
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateBody }>(
    "/v1/sources/:id",
    { schema: { body: UPDATE_BODY } },
    async (request, reply) => {
      requireScope(request.apiKey, "knowledge:write");

      const existing = await findOrFail(request.tenantCtx, request.params.id);
      const { name, config, syncSchedule, isActive } = request.body;
      assertValidSchedule(syncSchedule);

      const updated = await readInTenant(request.tenantCtx, (tx) =>
        tx.knowledgeSource.update({
          where: { id: existing.id },
          data: {
            ...(name === undefined ? {} : { name }),
            ...(config === undefined
              ? {}
              : {
                  config: encryptOrFail(
                    existing.kind,
                    validateOrFail(existing.kind, config),
                    (existing.config ?? {}) as Record<string, unknown>,
                    request.tenantCtx.tenantId,
                  ) as Prisma.InputJsonValue,
                }),
            ...(syncSchedule === undefined ? {} : { syncSchedule }),
            ...(isActive === undefined ? {} : { isActive }),
          },
          select: {
            id: true,
            name: true,
            kind: true,
            config: true,
            syncSchedule: true,
            isActive: true,
          },
        }),
      );

      return reply.send({
        ...updated,
        config: publicConfig(updated.kind, updated.config),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/sources/:id/sync",
    async (request, reply) => {
      requireScope(request.apiKey, "knowledge:write");

      const source = await findOrFail(request.tenantCtx, request.params.id);

      if (!source.isActive) {
        throw new ApiError(
          409,
          "source_inactive",
          "La fuente está desactivada. Actívala antes de sincronizarla.",
        );
      }

      // Ya en marcha: no se encola otra. Dos rastreos simultáneos del mismo
      // sitio duplican el trabajo, doblan la carga sobre el servidor del
      // cliente y compiten por escribir el mismo cursor.
      if (source.lastSyncStatus === "RUNNING") {
        throw new ApiError(
          409,
          "sync_in_progress",
          "Esa fuente ya se está sincronizando.",
        );
      }

      await readInTenant(request.tenantCtx, async (tx) => {
        // El estado y el evento, en la MISMA transacción. Si se publicara
        // fuera, un fallo entre ambos dejaría una fuente en PENDING que nadie
        // va a procesar nunca.
        await tx.knowledgeSource.update({
          where: { id: source.id },
          data: { lastSyncStatus: "PENDING", lastSyncError: null },
        });

        await publish(tx, {
          type: "source.sync.requested",
          tenantId: request.tenantCtx.tenantId,
          payload: { sourceId: source.id },
        });

        return null;
      });

      return reply.status(202).send({
        sourceId: source.id,
        status: "PENDING",
        statusUrl: `/v1/sources/${source.id}`,
      });
    },
  );

  app.get<{ Params: { id: string } }>("/v1/sources/:id", async (request, reply) => {
    requireScope(request.apiKey, "knowledge:read");

    const source = await findOrFail(request.tenantCtx, request.params.id);
    return reply.send({ ...source, config: publicConfig(source.kind, source.config) });
  });
}

/**
 * La configuración tal y como puede salir por la API.
 *
 * Un único sitio a propósito: cuatro respuestas devuelven configuración, y si
 * cada una decidiera por su cuenta qué ocultar, bastaría añadir una quinta para
 * filtrar un token.
 */
function publicConfig(kind: string, config: unknown): Record<string, unknown> {
  return redactSecrets(
    (config ?? {}) as Record<string, unknown>,
    connectorFor(kind).secretFields,
  );
}

/**
 * Cifra los campos secretos, o se niega a guardar.
 *
 * Sin clave de cifrado NO se acepta una configuración con credenciales.
 * Guardarla en claro sería peor que rechazarla: el cliente creería que su token
 * está protegido y estaría en la base y en todas las copias de seguridad.
 */
function encryptOrFail(
  kind: string,
  config: Record<string, unknown>,
  previous: Record<string, unknown>,
  tenantId: string,
): Record<string, unknown> {
  const fields = connectorFor(kind).secretFields;
  const traeSecreto = fields.some(
    (field) => config[field] !== undefined && config[field] !== null,
  );

  if (traeSecreto && !secretsReady()) {
    throw new ApiError(
      503,
      "secrets_unavailable",
      "El cifrado de secretos no está configurado, así que no se puede guardar " +
        "una credencial. Genera SECRETS_ENCRYPTION_KEY con: openssl rand -base64 32",
    );
  }

  try {
    // El propósito ata el texto cifrado a su sitio: un token movido a otro
    // campo, o a otro tenant, deja de descifrar.
    return encryptConfigSecrets(config, previous, fields, {
      tenantId,
      purposePrefix: "source.config",
    });
  } catch (error) {
    if (error instanceof SecretsError) {
      throw new ApiError(400, "invalid_secret", error.message);
    }
    throw error;
  }
}

/**
 * Un cron inválido se rechaza al guardarlo.
 *
 * Aceptarlo produce una fuente que no sincroniza nunca, y el síntoma —"mi web
 * no se actualiza"— aparece días después sin nada que lo explique.
 */
function assertValidSchedule(schedule: string | null | undefined): void {
  if (schedule === undefined || schedule === null || schedule.trim() === "") return;

  try {
    parseCron(schedule);
  } catch (error) {
    throw new ApiError(
      400,
      "invalid_schedule",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Valida la configuración con el conector que la va a usar.
 *
 * El conector es el único que sabe qué necesita, y duplicar aquí sus reglas
 * garantizaría que un día divergen y se acepta algo que el worker no sabe usar.
 */
function validateOrFail(kind: string, config: unknown): Record<string, unknown> {
  try {
    return connectorFor(kind).validateConfig(config);
  } catch (error) {
    if (error instanceof ConnectorError) {
      throw new ApiError(400, "invalid_source_config", error.message);
    }
    throw error;
  }
}

async function findOrFail(
  ctx: Parameters<typeof readInTenant>[0],
  id: string,
): Promise<{
  id: string;
  kind: string;
  config: unknown;
  isActive: boolean;
  lastSyncStatus: string | null;
}> {
  const source = await readInTenant(ctx, (tx) =>
    tx.knowledgeSource.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        kind: true,
        config: true,
        syncSchedule: true,
        lastSyncAt: true,
        lastSyncStatus: true,
        lastSyncError: true,
        isActive: true,
      },
    }),
  );

  // 404 y no 403: para este tenant, la fuente de otro no existe.
  if (source === null) {
    throw new ApiError(404, "not_found", `No existe la fuente ${id}.`);
  }

  return source as unknown as {
    id: string;
    kind: string;
    config: unknown;
    isActive: boolean;
    lastSyncStatus: string | null;
  };
}
