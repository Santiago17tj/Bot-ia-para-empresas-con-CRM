import type { FastifyInstance } from "fastify";

import { rawPrisma, runAsSystem } from "@platform/db";

/**
 * `/v1/health` (§27).
 *
 * Consulta la base de datos a propósito. Un health check que solo devuelve
 * `{"status":"ok"}` porque el proceso responde es un health check que dice que
 * todo va bien mientras Postgres está caído: el balanceador sigue mandando
 * tráfico a una instancia que no puede servir ni una respuesta.
 *
 * No lleva autenticación: quien vigila el servicio no tiene credencial de
 * ningún tenant, y darle una sería crear una llave que no debería existir.
 */
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/health", async (_request, reply) => {
    const startedAt = performance.now();

    try {
      await runAsSystem("health: comprobar que la base responde", () =>
        rawPrisma.$queryRaw`SELECT 1`,
      );
    } catch {
      // El motivo no se devuelve: una cadena de conexión en un endpoint sin
      // autenticar es una cadena de conexión pública.
      return reply.status(503).send({ status: "degraded", database: "unreachable" });
    }

    return reply.send({
      status: "ok",
      database: "ok",
      latencyMs: Math.round(performance.now() - startedAt),
    });
  });
}
