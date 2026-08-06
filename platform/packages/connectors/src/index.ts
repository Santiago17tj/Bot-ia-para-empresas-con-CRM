import { webConnector } from "./web.js";
import { ConnectorError, type SourceConnector } from "./types.js";

export { webConnector, USER_AGENT, extractLinks, parseSitemap, parseRobots } from "./web.js";
export type { WebSourceConfig } from "./web.js";

export {
  assertFetchableUrl,
  safeFetch,
  isPrivateAddress,
  BlockedUrlError,
} from "./net.js";
export type { FetchResult } from "./net.js";

export {
  parseCron,
  cronMatches,
  isValidCron,
  minuteOf,
  CronError,
} from "./cron.js";
export type { CronExpression } from "./cron.js";

export { ConnectorError } from "./types.js";
export type {
  DiscoveredDocument,
  SourceConnector,
  SyncContext,
  SyncCursor,
  SyncProgress,
} from "./types.js";

/**
 * Registro de conectores.
 *
 * `SITEMAP` y `URL` son el mismo conector: un sitemap es una forma de empezar,
 * no un origen distinto — el rastreador ya distingue por el contenido que le
 * devuelven. Tenerlos separados obligaría a mantener dos caminos idénticos.
 */
const CONNECTORS: Record<string, SourceConnector> = {
  URL: webConnector,
  SITEMAP: webConnector,
};

export function connectorFor(kind: string): SourceConnector {
  const connector = CONNECTORS[kind];
  if (connector === undefined) {
    throw new ConnectorError(
      `No hay conector para "${kind}". Implementados: ${Object.keys(CONNECTORS).join(", ")}.`,
      kind,
      true,
    );
  }
  return connector;
}

export function availableConnectors(): string[] {
  return Object.keys(CONNECTORS);
}
