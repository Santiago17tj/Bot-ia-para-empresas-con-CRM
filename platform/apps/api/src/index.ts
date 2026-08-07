import "@platform/env/load";

import { optional } from "@platform/env";
import { providerStatus } from "@platform/providers";

import { buildServer } from "./server.js";

export { buildServer, withTenant } from "./server.js";
export type { ServerOptions } from "./server.js";
export {
  generateApiKey,
  hashApiKey,
  extractBearer,
  requireScope,
  contextFor,
} from "./auth.js";
export type { AuthenticatedKey, IssuedKey } from "./auth.js";
export { ApiError } from "./errors.js";
export { issueApiKey, DEFAULT_SCOPES, UnknownTenantError } from "./issue.js";
export type { IssuedApiKey } from "./issue.js";
export { RateLimiter } from "./rate-limit.js";

/**
 * Arranque del servidor.
 *
 * `buildServer` se exporta aparte para que los tests construyan la aplicación
 * sin abrir un puerto: `app.inject()` recorre el mismo ciclo de vida completo
 * —hooks, validación, manejador de errores— sin red. Un test que arranca un
 * servidor real prueba además el sistema operativo, y falla por puertos
 * ocupados en CI.
 */

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]));

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

if (isEntrypoint) {
  const app = buildServer({ logger: true });
  const port = Number(optional("PORT") ?? 3001);

  // Se dice en voz alta qué está configurado. Una credencial ausente quita una
  // capacidad, y descubrirlo en la primera petición fallida cuesta una tarde.
  for (const status of providerStatus()) {
    app.log.info(`${status.ready ? "✓" : "✗"} ${status.label}`);
  }

  // `0.0.0.0` y no `localhost`: dentro de un contenedor, escuchar solo en el
  // loopback hace que el servicio sea inalcanzable desde fuera sin que nada
  // parezca roto.
  app.listen({ port, host: "0.0.0.0" }).catch((error: unknown) => {
    app.log.error(error);
    process.exitCode = 1;
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      // Cierre ordenado: las peticiones en vuelo terminan. Matar el proceso a
      // secas deja al cliente con una respuesta a medias y, peor, puede cortar
      // una transacción de ingesta por la mitad.
      void app.close().then(() => process.exit(0));
    });
  }
}
