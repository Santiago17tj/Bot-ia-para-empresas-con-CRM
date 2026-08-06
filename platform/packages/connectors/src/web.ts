import { createHash } from "node:crypto";

import { BlockedUrlError, assertFetchableUrl, safeFetch } from "./net.js";
import {
  ConnectorError,
  type DiscoveredDocument,
  type SourceConnector,
  type SyncContext,
  type SyncCursor,
} from "./types.js";

/**
 * Rastreador web: URL sueltas y sitemaps.
 *
 * Es el primer conector a propósito, y no Notion ni Drive. No necesita cuenta
 * de terceros, ni OAuth, ni secretos que cifrar — así que se puede construir Y
 * verificar entero. Y para una PYME su web ES su documentación: las condiciones
 * de envío, la política de devoluciones y las preguntas frecuentes ya están
 * publicadas, escritas y aprobadas.
 */

export const USER_AGENT =
  "PlatformKnowledgeBot/1.0 (+rastreador de conocimiento empresarial)";

export interface WebSourceConfig {
  /** Páginas o sitemaps por donde empezar. */
  startUrls: string[];
  maxPages: number;
  maxDepth: number;
  /** Pausa entre peticiones al mismo sitio. */
  delayMs: number;
  /** Solo se rastrean rutas que casen con alguno, si hay alguno. */
  includePatterns: string[];
  excludePatterns: string[];
  /** Respetar robots.txt. Se puede desactivar para el sitio propio. */
  respectRobots: boolean;
  /**
   * Credencial para sitios protegidos. Se guarda cifrada (§28).
   *
   * El caso real es la documentación interna: una intranet o un wiki detrás de
   * autenticación, que es justo donde una empresa tiene lo que no está en su
   * web pública.
   */
  authToken?: string;
}

const DEFAULTS: Omit<WebSourceConfig, "startUrls"> = {
  maxPages: 100,
  maxDepth: 3,
  // Un rastreador sin pausa contra un servidor pequeño es indistinguible de un
  // ataque, y quien lo sufre es el cliente al que se le quiere servir.
  delayMs: 500,
  includePatterns: [],
  excludePatterns: [],
  respectRobots: true,
};

const MAX_PAGE_BYTES = 5 * 1024 * 1024;

interface CrawlCursor extends SyncCursor {
  /** URL → huella del contenido la última vez. */
  seen?: Record<string, string>;
}

export const webConnector: SourceConnector = {
  kind: "URL",
  secretFields: ["authToken"],

  validateConfig(raw) {
    const config = (raw ?? {}) as Partial<WebSourceConfig>;
    const startUrls = config.startUrls;

    if (!Array.isArray(startUrls) || startUrls.length === 0) {
      throw new ConnectorError(
        "Una fuente web necesita al menos una URL de inicio (`startUrls`).",
        "URL",
        true,
      );
    }

    if (startUrls.length > 20) {
      throw new ConnectorError("Como mucho 20 URLs de inicio.", "URL", true);
    }

    for (const url of startUrls) {
      if (typeof url !== "string") {
        throw new ConnectorError("`startUrls` son cadenas.", "URL", true);
      }
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("protocolo");
        }
      } catch {
        throw new ConnectorError(`URL de inicio no válida: ${url}`, "URL", true);
      }
    }

    // Los patrones se compilan aquí: un regex inválido guardado en la
    // configuración explota la primera noche que sincroniza.
    for (const pattern of [
      ...(config.includePatterns ?? []),
      ...(config.excludePatterns ?? []),
    ]) {
      try {
        new RegExp(pattern);
      } catch {
        throw new ConnectorError(`Patrón no válido: ${pattern}`, "URL", true);
      }
    }

    return {
      startUrls,
      maxPages: clamp(config.maxPages ?? DEFAULTS.maxPages, 1, 2_000),
      maxDepth: clamp(config.maxDepth ?? DEFAULTS.maxDepth, 0, 10),
      delayMs: clamp(config.delayMs ?? DEFAULTS.delayMs, 0, 30_000),
      includePatterns: config.includePatterns ?? [],
      excludePatterns: config.excludePatterns ?? [],
      respectRobots: config.respectRobots ?? DEFAULTS.respectRobots,
      ...(typeof config.authToken === "string" && config.authToken !== ""
        ? { authToken: config.authToken }
        : {}),
    };
  },

  async sync(rawConfig, context) {
    const config = this.validateConfig(rawConfig) as unknown as WebSourceConfig;
    const cursor = (context.cursor ?? {}) as CrawlCursor;
    const previous = cursor.seen ?? {};
    const seen: Record<string, string> = {};

    const log = context.log ?? (() => {});
    const warnings: string[] = [];
    let discovered = 0;
    let skipped = 0;

    // Solo el origen de las URLs de inicio. Sin esto, un enlace a Wikipedia
    // convierte una sincronización en un rastreo de internet entero — y en un
    // segundo camino para alcanzar cosas que no son del cliente.
    const origins = new Set(config.startUrls.map((u) => new URL(u).origin));

    // La credencial se ata al origen de la PRIMERA URL de inicio. Si el
    // rastreo salta a otro dominio —una redirección, un enlace— la cabecera no
    // viaja: entregar el token del cliente a un tercero es peor que no rastrear
    // esa página.
    const auth =
      config.authToken === undefined
        ? undefined
        : {
            origin: new URL(config.startUrls[0] as string).origin,
            header: `Bearer ${config.authToken}`,
          };
    const robots = config.respectRobots ? new RobotsCache() : undefined;

    const queue: { url: string; depth: number }[] = [];
    const visited = new Set<string>();

    for (const start of config.startUrls) {
      queue.push({ url: canonical(start), depth: 0 });
    }

    while (queue.length > 0 && discovered + skipped < config.maxPages) {
      const item = queue.shift();
      if (item === undefined) break;
      if (visited.has(item.url)) continue;
      visited.add(item.url);

      if (!origins.has(new URL(item.url).origin)) continue;
      if (!matchesPatterns(item.url, config)) continue;

      if (robots !== undefined && !(await robots.allows(item.url))) {
        warnings.push(`robots.txt no permite ${item.url}`);
        continue;
      }

      let fetched;
      try {
        fetched = await safeFetch(item.url, {
          userAgent: USER_AGENT,
          ...(auth === undefined ? {} : { auth }),
        });
      } catch (error) {
        // Una URL rota no aborta la sincronización entera: se anota y se sigue.
        // Un sitio real siempre tiene algún enlace muerto, y que eso impida
        // indexar las otras noventa páginas sería absurdo.
        warnings.push(
          `${item.url}: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (error instanceof BlockedUrlError) continue;
        continue;
      }

      await pause(config.delayMs);

      if (fetched.status !== 200) {
        warnings.push(`${item.url}: HTTP ${fetched.status}`);
        continue;
      }

      if (fetched.bytes.byteLength > MAX_PAGE_BYTES) {
        warnings.push(`${item.url}: página de más de 5 MB, saltada`);
        continue;
      }

      const isSitemap =
        fetched.contentType.includes("xml") || /sitemap.*\.xml$/i.test(item.url);

      if (isSitemap) {
        // Un sitemap no es contenido: es una lista. Sus entradas entran en la
        // cola al mismo nivel, no un nivel más abajo — el sitemap es el índice,
        // no un salto de profundidad.
        for (const loc of parseSitemap(fetched.bytes.toString("utf8"))) {
          queue.push({ url: canonical(loc), depth: item.depth });
        }
        continue;
      }

      if (!fetched.contentType.includes("html") && !fetched.contentType.includes("text")) {
        continue;
      }

      const html = fetched.bytes.toString("utf8");
      const checksum = createHash("sha256").update(html).digest("hex");
      seen[fetched.url] = checksum;

      if (previous[fetched.url] === checksum) {
        // Ya estaba y no ha cambiado. Saltárselo AQUÍ ahorra el troceado y los
        // embeddings, que es donde está el coste de verdad.
        skipped++;
      } else {
        const document: DiscoveredDocument = {
          externalId: fetched.url,
          bytes: fetched.bytes,
          mimeType: "text/html",
          sourceRef: fetched.url,
          checksum,
          ...(titleOf(html) === undefined ? {} : { title: titleOf(html) as string }),
        };

        await context.emit(document);
        discovered++;
      }

      if (item.depth < config.maxDepth) {
        for (const link of extractLinks(html, fetched.url)) {
          if (!visited.has(link)) queue.push({ url: link, depth: item.depth + 1 });
        }
      }
    }

    if (queue.length > 0) {
      // Se dice en voz alta lo que quedó fuera. Un tope silencioso hace creer
      // que el sitio entero está indexado.
      warnings.push(
        `Se alcanzó el tope de ${config.maxPages} páginas: quedaron ${queue.length} ` +
          "en cola sin visitar. Sube `maxPages` si el sitio es mayor.",
      );
    }

    log(`[web] ${discovered} nuevas · ${skipped} sin cambios · ${warnings.length} avisos`);

    return {
      cursor: { seen } satisfies CrawlCursor,
      progress: { discovered, skipped, warnings },
    };
  },
};

/**
 * Normaliza la URL para no visitar dos veces la misma página.
 *
 * Se quita el fragmento —`#seccion` es la misma página— pero NO la query: en
 * muchos sitios `?id=3` es contenido distinto, y descartarla haría que el
 * rastreador viera una sola página donde hay cincuenta.
 */
function canonical(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  return url.toString();
}

function matchesPatterns(url: string, config: WebSourceConfig): boolean {
  if (config.excludePatterns.some((p) => new RegExp(p).test(url))) return false;
  if (config.includePatterns.length === 0) return true;
  return config.includePatterns.some((p) => new RegExp(p).test(url));
}

/** Enlaces del mismo documento, ya absolutos. */
export function extractLinks(html: string, base: string): string[] {
  const links: string[] = [];

  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const href = match[1];
    if (href === undefined) continue;
    if (/^(mailto|tel|javascript|data):/i.test(href.trim())) continue;

    try {
      const resolved = new URL(href, base);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
      links.push(canonical(resolved.toString()));
    } catch {
      // Un href malformado no es motivo para nada.
    }
  }

  return [...new Set(links)];
}

/** Las `<loc>` de un sitemap, incluido el índice de sitemaps. */
export function parseSitemap(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map((m) => (m[1] ?? "").trim())
    .filter((loc) => loc !== "");
}

function titleOf(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title === undefined || title === "" ? undefined : title;
}

/**
 * robots.txt, uno por origen y cacheado durante la sincronización.
 *
 * Deliberadamente simple: `Disallow` de `User-agent: *` y del nuestro. No
 * implementa `Allow` con precedencia por longitud ni comodines completos —
 * lo que hace es no entrar donde el sitio ha pedido no entrar, que es el
 * compromiso que importa.
 */
class RobotsCache {
  readonly #byOrigin = new Map<string, string[]>();

  async allows(url: string): Promise<boolean> {
    const { origin, pathname } = new URL(url);

    let rules = this.#byOrigin.get(origin);
    if (rules === undefined) {
      rules = await this.#load(origin);
      this.#byOrigin.set(origin, rules);
    }

    return !rules.some((rule) => pathname.startsWith(rule));
  }

  async #load(origin: string): Promise<string[]> {
    try {
      await assertFetchableUrl(`${origin}/robots.txt`);
      const result = await safeFetch(`${origin}/robots.txt`, {
        userAgent: USER_AGENT,
        timeoutMs: 10_000,
      });
      if (result.status !== 200) return [];
      return parseRobots(result.bytes.toString("utf8"));
    } catch {
      // Sin robots.txt no hay prohibición. Es lo que dice el estándar y lo que
      // hace cualquier rastreador: su ausencia no es una negativa.
      return [];
    }
  }
}

/** Rutas prohibidas para nosotros o para todos. */
export function parseRobots(text: string): string[] {
  const disallowed: string[] = [];
  let applies = false;

  for (const line of text.split(/\r?\n/)) {
    const clean = line.split("#")[0]?.trim() ?? "";
    if (clean === "") continue;

    const [rawKey, ...rest] = clean.split(":");
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      applies = value === "*" || USER_AGENT.toLowerCase().includes(value.toLowerCase());
      continue;
    }

    if (key === "disallow" && applies && value !== "") disallowed.push(value);
  }

  return disallowed;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function pause(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}
