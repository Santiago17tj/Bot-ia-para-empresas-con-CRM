import { randomUUID } from "node:crypto";

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

import { runWithTenant, withRlsTransaction, type TenantContext } from "@platform/db";
import type { AIProvider, EmbeddingProvider } from "@platform/providers";

import {
  authenticate,
  contextFor,
  extractBearer,
  type AuthenticatedKey,
} from "./auth.js";
import { ApiError, toErrorResponse } from "./errors.js";
import { RateLimiter } from "./rate-limit.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerContactRoutes } from "./routes/contacts.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerGapRoutes } from "./routes/gaps.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSourceRoutes } from "./routes/sources.js";
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
  /**
   * Proveedores inyectados. **Para tests.**
   *
   * Sin esto, probar el chat exige llamar a un modelo de verdad, y lo que hay
   * que comprobar —que el hilo da continuidad, que la pregunta reescrita es la
   * que se busca— no depende de qué modelo sea. Es la misma costura que
   * `ingestDocument` tiene para la transacción.
   *
   * En producción se omite y cada ruta resuelve el suyo por configuración.
   */
  providers?: { ai?: AIProvider; embedding?: EmbeddingProvider };
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
    //
    // Un `ApiError` NUESTRO se deja intacto y esa comprobación va primero. Sin
    // ella, esta normalización lo reenvolvía —también lleva `statusCode` 4xx— y
    // le borraba el `code`: `contact_exists` y `not_found` salían los dos como
    // `bad_request`. El `code` existe para que un cliente pueda ramificar sin
    // leer el texto en español, así que uno que siempre vale lo mismo no es un
    // detalle cosmético: es el campo entero sin servir para nada.
    const normalized =
      !(error instanceof ApiError) &&
      error.statusCode !== undefined &&
      error.statusCode >= 400 &&
      error.statusCode < 500
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

    const injected = options.providers ?? {};

    await scope.register(registerKnowledgeRoutes, injected);
    await scope.register(registerDocumentRoutes);
    await scope.register(registerGapRoutes);
    await scope.register(registerSourceRoutes);
    await scope.register(registerChatRoutes, injected);
    await scope.register(registerContactRoutes);
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
  // El `await` de dentro no sobra: es lo único que hace correcta esta función.
  //
  // Las consultas de Prisma son PEREZOSAS. `prisma.document.findMany(...)`
  // devuelve una promesa que todavía no ha empezado; la consulta sale cuando
  // alguien la espera. Con `runWithTenant(ctx, fn)` a secas, un manejador que
  // escriba `withTenant(ctx, () => prisma.document.findMany(...))` construye la
  // consulta dentro del contexto y la EJECUTA fuera, ya cerrado el
  // AsyncLocalStorage — y la extensión falla con "sin contexto resuelto".
  //
  // Awaitándola aquí dentro, la ejecución arranca dentro del contexto y da
  // igual si el manejador devolvió una promesa perezosa o una en marcha.
  //
  // Se descubrió con un 500, no con una fuga: sin contexto la extensión falla
  // cerrado. Ese es el diseño funcionando.
  return runWithTenant(ctx, async () => await fn());
}

/**
 * Lee datos del tenant. **La única forma correcta de leer en un manejador.**
 *
 * `withTenant` abre el contexto de la aplicación, pero la tercera capa de
 * aislamiento —las políticas RLS— lee `app.tenant_id` de la SESIÓN de Postgres,
 * y eso lo fija `withRlsTransaction` de forma local a la transacción. Una
 * consulta con `prisma` fuera de una transacción tiene contexto de aplicación y
 * no tiene el de Postgres.
 *
 * Y ahí está el filo: no falla. La capa 2 añade su `WHERE tenantId`, la capa 3
 * no encuentra el ajuste y no deja pasar nada, y el resultado es **cero filas
 * en silencio**. No es una fuga —el aislamiento aguanta— pero sí un listado
 * vacío o una configuración que parece no existir y se sustituye por valores
 * por defecto sin que nadie se entere.
 *
 * Se descubrió así: la ruta de respuesta leía `TenantAIConfig` fuera de
 * transacción, recibía `null` y servía el umbral por defecto del sistema en vez
 * del del cliente. Todo verde y todo mal.
 */
export function readInTenant<T>(
  ctx: TenantContext,
  fn: (tx: Parameters<Parameters<typeof withRlsTransaction<T>>[0]>[0]) => Promise<T>,
): Promise<T> {
  return withTenant(ctx, () => withRlsTransaction(fn));
}
