import { randomUUID } from "node:crypto";

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

import { runWithTenant, type TenantContext } from "@platform/db";

import {
  authenticate,
  contextFor,
  extractBearer,
  type AuthenticatedKey,
} from "./auth.js";
import { ApiError, toErrorResponse } from "./errors.js";
import { RateLimiter } from "./rate-limit.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerKnowledgeRoutes } from "./routes/knowledge.js";

declare module "fastify" {
  interface FastifyRequest {
    /** La credencial ya resuelta. Solo dentro del ámbito autenticado. */
    apiKey: AuthenticatedKey;
    /** El contexto derivado de la credencial. NUNCA del cuerpo de la petición. */
    tenantCtx: TenantContext;
  }
}

export interface ServerOptions {
  logger?: boolean;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    // El id de petición viaja en la traza, en el error que ve el cliente y en
    // los logs. Se acepta el de aguas arriba para poder seguir una llamada que
    // atravesó un proxy antes de llegar aquí.
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && incoming.length <= 200
        ? incoming
        : `req_${randomUUID()}`;
    },
    // Un cuerpo de 1 MB es holgado para una pregunta y ridículo comparado con
    // lo que aceptaría por defecto. El límite es la defensa barata.
    bodyLimit: 1_048_576,
  });

  app.addHook("onSend", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Fastify ya clasifica lo que es culpa del cliente: validación de esquema,
    // JSON mal formado, Content-Length que no cuadra, tipo no soportado. Todos
    // traen un `statusCode` 4xx y un mensaje que describe qué está mal sin
    // revelar nada interno.
    //
    // Sin esto, un cuerpo mal codificado se devolvía como 500 "error interno" y
    // además se registraba como fallo nuestro. El cliente no puede arreglar lo
    // que la API le dice que es un problema del servidor, y nosotros
    // perseguiríamos una alarma que no lo era.
    const normalized =
      error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500
        ? new ApiError(
            error.statusCode,
            error.validation === undefined ? "bad_request" : "invalid_request",
            error.message,
          )
        : error;

    const { statusCode, body } = toErrorResponse(normalized, String(request.id));

    if (statusCode >= 500) {
      request.log.error({ err: error, reqId: request.id }, "petición fallida");
    }

    void reply.status(statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: "not_found",
        message: `No existe ${request.method} ${request.url}.`,
        requestId: String(request.id),
      },
    });
  });

  // Sin autenticar: quien vigila el servicio no tiene credencial de tenant.
  void app.register(registerHealthRoutes);

  const limiter = new RateLimiter();
  const sweeper = setInterval(() => limiter.sweep(), 60_000);
  // `unref` para que un temporizador de limpieza no impida que el proceso
  // termine — es exactamente el fallo que deja un test colgado para siempre.
  sweeper.unref();

  void app.register(async (scope) => {
    scope.addHook("onRequest", async (request) => {
      const secret = extractBearer(request.headers.authorization);
      if (secret === undefined) {
        throw new ApiError(
          401,
          "unauthorized",
          "Falta la credencial. Usa: Authorization: Bearer <clave>.",
        );
      }

      const key = await authenticate(secret);

      const retryAfter = limiter.check(key.id, key.rateLimitPerMinute);
      if (retryAfter !== undefined) {
        throw new ApiError(
          429,
          "rate_limited",
          `Límite de ${key.rateLimitPerMinute} peticiones por minuto superado. ` +
            `Reintenta en ${retryAfter} s.`,
        );
      }

      request.apiKey = key;
      request.tenantCtx = contextFor(key, String(request.id));
    });

    await scope.register(registerKnowledgeRoutes);
  });

  return app;
}

/**
 * Ejecuta el manejador dentro del contexto de tenant de la credencial.
 *
 * Hace falta un envoltorio y no basta con abrirlo en el hook porque el contexto
 * vive dentro de la llamada a `runWithTenant`: un hook que lo abre y retorna lo
 * cierra antes de que el manejador empiece.
 *
 * Olvidarlo NO filtra datos de otro cliente — la extensión de Prisma falla
 * cerrado sin contexto y la petición muere con un 500. Ese es el diseño: el
 * olvido produce un error ruidoso, nunca una respuesta con datos ajenos.
 */
export function withTenant<T>(
  ctx: TenantContext,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithTenant(ctx, fn);
}
