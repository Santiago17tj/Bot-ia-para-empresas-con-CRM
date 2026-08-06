import { blocksToMarkdown, richTextToMarkdown, type NotionBlock } from "./notion-blocks.js";
import {
  ConnectorError,
  type DiscoveredDocument,
  type SourceConnector,
  type SyncCursor,
} from "./types.js";

/**
 * Conector de Notion.
 *
 * **Token interno, no OAuth.** OAuth público exige registrar una integración en
 * Notion, alojar una URL de callback y pasar su revisión; el camino que una PYME
 * usa de verdad es crear una integración interna en su espacio y pegar el token.
 * Ese token es un secreto y va cifrado en reposo (§28) — es exactamente el caso
 * para el que se construyó `@platform/secrets`.
 *
 * Cuando llegue OAuth, el token acaba en el mismo campo y nada de aquí cambia:
 * lo que cambia es de dónde sale.
 *
 * ---
 *
 * **La integración solo ve lo que le han compartido.** Es la primera fuente de
 * "no funciona" con Notion y no es un fallo: en Notion hay que compartir cada
 * página o base de datos con la integración, una por una o por herencia. Un
 * espacio entero con la integración creada y nada compartido devuelve cero
 * resultados. Por eso ese caso emite un aviso que lo explica en vez de terminar
 * en verde con cero documentos.
 */

const NOTION_VERSION = "2022-06-28";
const DEFAULT_BASE_URL = "https://api.notion.com/v1";

/**
 * Notion limita a unas 3 peticiones por segundo por integración.
 *
 * Pasarse devuelve 429 y, sostenido, se gana un bloqueo temporal del token del
 * cliente — que es su token, no el nuestro. La pausa es barata comparada con
 * eso.
 */
const REQUEST_DELAY_MS = 350;

export interface NotionSourceConfig {
  /** Token de integración interna (`ntn_…`). Secreto. */
  token: string;
  /** Tope de páginas por sincronización. */
  maxPages: number;
  /** Incluir páginas archivadas. Normalmente no: están archivadas por algo. */
  includeArchived: boolean;
  /** Solo para tests: apunta el cliente a otro servidor. */
  baseUrl?: string;
  /**
   * Solo para tests: pausa entre peticiones.
   *
   * En producción NO se toca. No es cortesía como en el rastreador web —donde
   * el servidor es del cliente y se le puede pedir permiso— sino un límite duro
   * de Notion: unas 3 peticiones por segundo por integración. Pasarse devuelve
   * 429 y, sostenido, bloquea el token DEL CLIENTE.
   */
  requestDelayMs?: number;
}

interface NotionCursor extends SyncCursor {
  /** id de página → `last_edited_time` de la última vez que se ingirió. */
  seen?: Record<string, string>;
}

interface SearchResult {
  id: string;
  object: string;
  url?: string;
  archived?: boolean;
  in_trash?: boolean;
  last_edited_time?: string;
  properties?: Record<string, unknown>;
  title?: unknown[];
}

export const notionConnector: SourceConnector = {
  kind: "NOTION",
  secretFields: ["token"],

  validateConfig(raw) {
    const config = (raw ?? {}) as Partial<NotionSourceConfig>;

    // El token puede venir ya cifrado en una actualización: se acepta tal cual
    // y lo descifra el worker. Exigir aquí el formato en claro impediría
    // cambiar `maxPages` sin volver a escribir la credencial.
    if (typeof config.token !== "string" || config.token.trim() === "") {
      throw new ConnectorError(
        "Falta el token de Notion. Créalo en notion.so/my-integrations, y " +
          "COMPARTE con esa integración las páginas que quieras indexar: sin " +
          "compartirlas, la integración no ve nada.",
        "NOTION",
        true,
      );
    }

    return {
      token: config.token,
      maxPages: clamp(config.maxPages ?? 500, 1, 5_000),
      includeArchived: config.includeArchived ?? false,
      ...(typeof config.baseUrl === "string" && config.baseUrl !== ""
        ? { baseUrl: config.baseUrl }
        : {}),
      ...(typeof config.requestDelayMs === "number"
        ? { requestDelayMs: clamp(config.requestDelayMs, 0, 5_000) }
        : {}),
    };
  },

  async sync(rawConfig, context) {
    const config = this.validateConfig(rawConfig) as unknown as NotionSourceConfig;
    const client = new NotionClient(
      config.token,
      config.baseUrl ?? DEFAULT_BASE_URL,
      config.requestDelayMs ?? REQUEST_DELAY_MS,
    );

    const cursor = (context.cursor ?? {}) as NotionCursor;
    const previous = cursor.seen ?? {};
    const seen: Record<string, string> = {};

    const log = context.log ?? (() => {});
    const warnings: string[] = [];
    let discovered = 0;
    let skipped = 0;

    const pages = await client.searchPages(config.maxPages, config.includeArchived);

    if (pages.length === 0) {
      warnings.push(
        "La integración no ve ninguna página. En Notion hay que COMPARTIR cada " +
          "página o base de datos con ella (menú ··· → Conexiones). Crearla no " +
          "basta.",
      );
    }

    for (const page of pages) {
      const editedAt = page.last_edited_time ?? "";
      seen[page.id] = editedAt;

      // Notion da la fecha de última edición, así que lo no modificado se salta
      // ANTES de descargar sus bloques. Es más barato que comparar contenido:
      // una página de cien bloques son varias peticiones que no se hacen.
      if (editedAt !== "" && previous[page.id] === editedAt) {
        skipped++;
        continue;
      }

      let blocks: NotionBlock[];
      try {
        blocks = await client.pageBlocks(page.id);
      } catch (error) {
        // Una página que falla no aborta la sincronización: se anota y se sigue.
        warnings.push(
          `${page.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        // No se guarda su marca de tiempo, así que se reintenta la próxima vez.
        delete seen[page.id];
        continue;
      }

      const markdown = blocksToMarkdown(blocks);
      const title = titleOf(page);

      if (markdown.trim() === "") {
        // Una página vacía no es un error, pero indexarla sería crear un
        // documento que no responde nada.
        warnings.push(`"${title}" no tiene contenido de texto: no se indexa.`);
        continue;
      }

      const document: DiscoveredDocument = {
        externalId: page.id,
        title,
        // El título va DENTRO del markdown como encabezado de primer nivel: el
        // troceador construye las migas de pan con los encabezados, y sin él
        // las citas de esta página empezarían por su primera sección.
        bytes: Buffer.from(`# ${title}\n\n${markdown}\n`, "utf8"),
        mimeType: "text/markdown",
        sourceRef: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, "")}`,
      };

      await context.emit(document);
      discovered++;
    }

    log(
      `[notion] ${discovered} páginas nuevas o cambiadas · ${skipped} sin cambios · ` +
        `${warnings.length} avisos`,
    );

    return {
      cursor: { seen } satisfies NotionCursor,
      progress: { discovered, skipped, warnings },
    };
  },
};

/**
 * Cliente mínimo de la API de Notion.
 *
 * Se escribe a mano en vez de traer `@notionhq/client` por lo mismo que el
 * adaptador de proveedores de IA: son dos endpoints con paginación por cursor,
 * y el SDK añadiría una versión que mantener y una superficie que no se usa.
 */
class NotionClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #delayMs: number;

  constructor(token: string, baseUrl: string, delayMs: number) {
    this.#token = token;
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#delayMs = delayMs;
  }

  async #request(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "notion-version": NOTION_VERSION,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ConnectorError(
        explain(response.status, detail),
        "NOTION",
        // 401 y 403 son configuración: el token es inválido o no le han
        // compartido nada. Reintentarlo cinco veces solo retrasa el
        // diagnóstico.
        response.status === 401 || response.status === 403,
      );
    }

    await pause(this.#delayMs);
    return (await response.json()) as Record<string, unknown>;
  }

  /** Las páginas que la integración puede ver, paginadas. */
  async searchPages(maxPages: number, includeArchived: boolean): Promise<SearchResult[]> {
    const pages: SearchResult[] = [];
    let cursor: string | undefined;

    do {
      const body: Record<string, unknown> = {
        filter: { property: "object", value: "page" },
        page_size: 100,
        ...(cursor === undefined ? {} : { start_cursor: cursor }),
      };

      const result = await this.#request("/search", body);
      const batch = (result["results"] ?? []) as SearchResult[];

      for (const page of batch) {
        if (pages.length >= maxPages) break;
        if (!includeArchived && (page.archived === true || page.in_trash === true)) {
          continue;
        }
        pages.push(page);
      }

      cursor =
        result["has_more"] === true && typeof result["next_cursor"] === "string"
          ? result["next_cursor"]
          : undefined;
    } while (cursor !== undefined && pages.length < maxPages);

    return pages;
  }

  /**
   * Los bloques de una página, con sus hijos resueltos.
   *
   * Notion sirve los hijos en peticiones aparte, así que una página con listas
   * anidadas son muchas llamadas. El tope de profundidad evita que una página
   * patológica —o un ciclo en los datos— consuma la cuota del cliente entera.
   */
  async pageBlocks(blockId: string, depth = 0): Promise<NotionBlock[]> {
    if (depth > 5) return [];

    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;

    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (cursor !== undefined) query.set("start_cursor", cursor);

      const result = await this.#request(`/blocks/${blockId}/children?${query.toString()}`);
      const batch = (result["results"] ?? []) as NotionBlock[];

      for (const block of batch) {
        if (block.has_children === true) {
          block.children = await this.pageBlocks(block.id, depth + 1);
        }
        blocks.push(block);
      }

      cursor =
        result["has_more"] === true && typeof result["next_cursor"] === "string"
          ? result["next_cursor"]
          : undefined;
    } while (cursor !== undefined);

    return blocks;
  }
}

/**
 * El título de una página.
 *
 * Notion lo guarda en un sitio distinto según de dónde cuelgue: una página
 * suelta lo tiene en `properties.title`, y una fila de base de datos en la
 * propiedad que el cliente haya marcado como título, que puede llamarse
 * cualquier cosa. Buscar por tipo y no por nombre es lo que hace que funcione
 * con un espacio en español.
 */
export function titleOf(page: SearchResult): string {
  const properties = page.properties ?? {};

  for (const value of Object.values(properties)) {
    const property = value as { type?: string; title?: unknown[] };
    if (property.type === "title" && Array.isArray(property.title)) {
      const text = richTextToMarkdown(property.title as never).trim();
      if (text !== "") return text;
    }
  }

  return "Página sin título";
}

/** Mensajes accionables para los errores que de verdad ocurren. */
function explain(status: number, detail: string): string {
  if (status === 401) {
    return "Notion rechazó el token (401). Revísalo en notion.so/my-integrations; " +
      "si lo has regenerado, hay que actualizarlo aquí.";
  }
  if (status === 403) {
    return "Notion respondió 403: la integración existe pero no tiene acceso. " +
      "Comparte con ella las páginas desde el menú ··· → Conexiones.";
  }
  if (status === 429) {
    return "Notion está limitando las peticiones (429). La sincronización se " +
      "reintentará; si se repite, baja `maxPages`.";
  }
  return `Notion respondió ${status}: ${detail.slice(0, 300)}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function pause(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}
