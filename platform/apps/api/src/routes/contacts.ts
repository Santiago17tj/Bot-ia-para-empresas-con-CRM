import type { FastifyInstance } from "fastify";

import { requireScope } from "../auth.js";
import { ApiError } from "../errors.js";
import { readInTenant } from "../server.js";

/**
 * `/v1/contacts` — quién pregunta (§27).
 *
 * Cierra la superficie de la API que el plan fija para esta fase. Es el
 * contacto MÍNIMO: identidad y datos, para que varias conversaciones de la
 * misma persona dejen de ser personas distintas. No es un CRM — `Company`,
 * oportunidades y sincronización con un sistema externo son Fase 4.
 *
 * Como el resto de rutas, esta no decide nada: no hay lógica de negocio aquí
 * que no esté medida en otro sitio. Lee y escribe filas con el tenant que trae
 * la credencial, y nada más.
 */

const LIST_QUERY = {
  type: "object",
  additionalProperties: false,
  properties: {
    // Búsqueda por dato exacto, que es como se busca a una persona cuando
    // llega un mensaje: por su número o por su correo. La búsqueda por texto
    // libre es otra cosa y no se finge aquí.
    email: { type: "string" },
    phone: { type: "string" },
    externalId: { type: "string" },
    channel: { type: "string", enum: ["API", "WEB", "WHATSAPP", "EMAIL", "SLACK"] },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  },
} as const;

const CONTACT_BODY = {
  type: "object",
  additionalProperties: false,
  properties: {
    displayName: { type: "string", maxLength: 200 },
    email: { type: "string", maxLength: 320 },
    phone: { type: "string", maxLength: 40 },
    externalId: { type: "string", maxLength: 200 },
    channel: { type: "string", enum: ["API", "WEB", "WHATSAPP", "EMAIL", "SLACK"] },
    attributes: { type: "object", additionalProperties: true },
  },
} as const;

type Channel = "API" | "WEB" | "WHATSAPP" | "EMAIL" | "SLACK";

interface ListQuery {
  email?: string;
  phone?: string;
  externalId?: string;
  channel?: Channel;
  limit?: number;
}

interface ContactBody {
  displayName?: string;
  email?: string;
  phone?: string;
  externalId?: string;
  channel?: Channel;
  attributes?: Record<string, unknown>;
}

const SELECT = {
  id: true,
  displayName: true,
  email: true,
  phone: true,
  externalId: true,
  channel: true,
  attributes: true,
  createdAt: true,
  updatedAt: true,
  lastSeenAt: true,
} as const;

export async function registerContactRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListQuery }>(
    "/v1/contacts",
    { schema: { querystring: LIST_QUERY } },
    async (request, reply) => {
      requireScope(request.apiKey, "contacts:read");

      const { email, phone, externalId, channel, limit = 50 } = request.query;

      const contacts = await readInTenant(request.tenantCtx, (tx) =>
        tx.contact.findMany({
          where: {
            ...(email === undefined ? {} : { email }),
            ...(phone === undefined ? {} : { phone }),
            ...(externalId === undefined ? {} : { externalId }),
            ...(channel === undefined ? {} : { channel }),
          },
          // Por visto por última vez: quien escribió hoy importa más que quien
          // se dio de alta primero.
          orderBy: { lastSeenAt: "desc" },
          take: limit,
          select: SELECT,
        }),
      );

      return reply.send({ contacts });
    },
  );

  app.post<{ Body: ContactBody }>(
    "/v1/contacts",
    { schema: { body: CONTACT_BODY } },
    async (request, reply) => {
      requireScope(request.apiKey, "contacts:write");

      const body = request.body;

      // Un contacto sin ningún identificador no sirve para nada: no se le puede
      // volver a encontrar, así que la siguiente conversación crearía otro.
      if (
        body.email === undefined &&
        body.phone === undefined &&
        body.externalId === undefined
      ) {
        throw new ApiError(
          400,
          "invalid_contact",
          "Un contacto necesita al menos email, phone o externalId. Sin ninguno " +
            "no se le puede volver a encontrar, y la siguiente conversación " +
            "crearía un duplicado.",
        );
      }

      // `externalId` sin canal no identifica a nadie: el mismo literal en
      // WhatsApp y en Slack son dos personas distintas, y así lo dice la
      // unicidad compuesta del esquema.
      if (body.externalId !== undefined && body.channel === undefined) {
        throw new ApiError(
          400,
          "invalid_contact",
          "externalId exige channel: el mismo identificador en dos canales " +
            "distintos no es la misma persona.",
        );
      }

      try {
        const created = await readInTenant(request.tenantCtx, (tx) =>
          tx.contact.create({
            data: {
              tenantId: request.tenantCtx.tenantId,
              ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
              ...(body.email === undefined ? {} : { email: body.email }),
              ...(body.phone === undefined ? {} : { phone: body.phone }),
              ...(body.externalId === undefined ? {} : { externalId: body.externalId }),
              ...(body.channel === undefined ? {} : { channel: body.channel }),
              ...(body.attributes === undefined
                ? {}
                : { attributes: body.attributes as object }),
            },
            select: SELECT,
          }),
        );

        return reply.code(201).send(created);
      } catch (error) {
        // 409 y no 500: la unicidad compuesta hizo su trabajo. El cliente tiene
        // que decidir si actualiza el que ya existe, y decírselo con un 500 le
        // haría creer que el fallo es nuestro.
        if (isUniqueViolation(error)) {
          throw new ApiError(
            409,
            "contact_exists",
            "Ya existe un contacto con ese email, teléfono o identificador de canal.",
          );
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>("/v1/contacts/:id", async (request, reply) => {
    requireScope(request.apiKey, "contacts:read");

    const contact = await readInTenant(request.tenantCtx, (tx) =>
      tx.contact.findUnique({
        where: { id: request.params.id },
        select: {
          ...SELECT,
          // El historial es la mitad del valor de tener contactos: saber que
          // esta persona ya preguntó tres veces cambia cómo se la atiende.
          conversations: {
            orderBy: { lastMessageAt: "desc" },
            take: 20,
            select: {
              id: true,
              channel: true,
              status: true,
              messageCount: true,
              lastMessageAt: true,
            },
          },
        },
      }),
    );

    // 404 y no 403: para este tenant, el contacto de otro no existe.
    if (contact === null) {
      throw new ApiError(404, "not_found", `No existe el contacto ${request.params.id}.`);
    }

    return reply.send(contact);
  });

  app.patch<{ Params: { id: string }; Body: ContactBody }>(
    "/v1/contacts/:id",
    { schema: { body: CONTACT_BODY } },
    async (request, reply) => {
      requireScope(request.apiKey, "contacts:write");

      const existing = await readInTenant(request.tenantCtx, (tx) =>
        tx.contact.findUnique({ where: { id: request.params.id }, select: { id: true } }),
      );

      if (existing === null) {
        throw new ApiError(
          404,
          "not_found",
          `No existe el contacto ${request.params.id}.`,
        );
      }

      const body = request.body;

      try {
        const updated = await readInTenant(request.tenantCtx, (tx) =>
          tx.contact.update({
            where: { id: request.params.id },
            data: {
              ...(body.displayName === undefined
                ? {}
                : { displayName: body.displayName }),
              ...(body.email === undefined ? {} : { email: body.email }),
              ...(body.phone === undefined ? {} : { phone: body.phone }),
              ...(body.externalId === undefined ? {} : { externalId: body.externalId }),
              ...(body.channel === undefined ? {} : { channel: body.channel }),
              ...(body.attributes === undefined
                ? {}
                : { attributes: body.attributes as object }),
            },
            select: SELECT,
          }),
        );

        return reply.send(updated);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(
            409,
            "contact_exists",
            "Otro contacto ya usa ese email, teléfono o identificador de canal.",
          );
        }
        throw error;
      }
    },
  );
}

/**
 * P2002 de Prisma: violación de restricción única.
 *
 * Se mira el código y no el mensaje porque el mensaje cambia entre versiones y
 * está traducido; un `includes("Unique constraint")` deja de funcionar el día
 * que alguien sube Prisma, y lo hace devolviendo 500 en vez de 409.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}
