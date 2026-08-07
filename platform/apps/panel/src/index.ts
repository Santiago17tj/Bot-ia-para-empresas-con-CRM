import "@platform/env/load";

import { optional } from "@platform/env";

import { buildPanel } from "./server.js";

export { buildPanel } from "./server.js";
export type { PanelOptions } from "./server.js";
export {
  COOKIE,
  clearCookie,
  openApiKey,
  sealApiKey,
  sessionCookie,
  sessionReady,
} from "./session.js";

/**
 * Arranque del panel.
 *
 * Proceso aparte de la API, igual que el worker, y por un motivo distinto: no
 * es rendimiento, es superficie. El panel sirve HTML a un navegador y la API
 * sirve JSON a integraciones; juntarlos haría que una vulnerabilidad de la
 * interfaz —una plantilla, una cookie— viviera dentro del proceso que atiende
 * a los clientes por API.
 */

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]));

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

if (isEntrypoint) {
  const app = buildPanel({ logger: true });
  const port = Number(optional("PANEL_PORT") ?? 3002);

  app.listen({ port, host: "0.0.0.0" }).catch((error: unknown) => {
    app.log.error(error);
    process.exitCode = 1;
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}
