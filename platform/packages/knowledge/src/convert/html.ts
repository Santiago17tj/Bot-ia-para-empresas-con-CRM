import type { ConversionResult, DocumentConverter } from "./types.js";

/**
 * HTML → Markdown, conservando la jerarquía de encabezados.
 *
 * Sin dependencias: el subconjunto de HTML que importa para conocimiento
 * corporativo (encabezados, párrafos, listas, tablas, enlaces) es pequeño, y
 * una librería completa arrastra un DOM entero para eso.
 */

const BLOCK_DROP = /<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Entidades habituales. Las numéricas se resuelven aparte. */
const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&aacute;": "á",
  "&eacute;": "é",
  "&iacute;": "í",
  "&oacute;": "ó",
  "&uacute;": "ú",
  "&ntilde;": "ñ",
  "&Ntilde;": "Ñ",
  "&uuml;": "ü",
};

export function decodeEntities(text: string): string {
  let out = text;
  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.replaceAll(entity, char);
  }
  return out
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

/**
 * Extrae el contenido principal descartando navegación y pies.
 *
 * Una página corporativa mete el menú, el aviso de cookies y el pie en cada
 * documento. Indexarlos hace que "política" recupere el enlace del pie de
 * página en vez de la política, en todas las páginas a la vez.
 */
function mainContent(html: string): string {
  const main = /<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i.exec(html);
  if (main?.[1] !== undefined) return main[1];

  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const scope = body?.[1] ?? html;

  return scope.replace(
    /<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );
}

export function htmlToMarkdown(html: string): ConversionResult {
  const warnings: string[] = [];

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const langMatch = /<html\b[^>]*\blang=["']?([a-z]{2})/i.exec(html);

  let text = mainContent(html.replace(BLOCK_DROP, ""));

  // Tablas antes que nada: su contenido lleva etiquetas que el resto borraría.
  text = text.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner: string) =>
    `\n\n${tableToMarkdown(inner)}\n\n`,
  );

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section)>/gi, "\n\n")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, body: string) => {
      const title = stripTags(body).trim();
      return title === "" ? "" : `\n\n${"#".repeat(Number(level))} ${title}\n\n`;
    })
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, body: string) => {
      const item = stripTags(body).trim();
      return item === "" ? "" : `\n- ${item}`;
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, body: string) => {
      const inner = stripTags(body).trim();
      return inner === "" ? "" : `**${inner}**`;
    })
    .replace(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, body: string) => {
        const label = stripTags(body).trim();
        return label === "" ? "" : `[${label}](${href})`;
      },
    );

  const markdown = normalizeBlankLines(decodeEntities(stripTags(text)));

  if (/<table\b/i.test(html) && !markdown.includes("|")) {
    warnings.push("Había tablas en el HTML que no se pudieron convertir.");
  }

  const result: ConversionResult = { markdown, warnings };
  const title = titleMatch?.[1] === undefined ? undefined : decodeEntities(titleMatch[1]).trim();
  if (title !== undefined && title !== "") result.title = title;
  if (langMatch?.[1] !== undefined) result.language = langMatch[1].toLowerCase();

  return result;
}

function tableToMarkdown(inner: string): string {
  const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...(row[1] as string).matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((cell) =>
      decodeEntities(stripTags(cell[2] as string)).replace(/\s+/g, " ").trim(),
    ),
  );

  const withCells = rows.filter((r) => r.length > 0);
  if (withCells.length === 0) return "";

  const header = withCells[0] as string[];
  const separator = header.map(() => "---");
  const body = withCells.slice(1);

  return [header, separator, ...body].map((r) => `| ${r.join(" | ")} |`).join("\n");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/** Colapsa saltos: tres o más líneas en blanco no significan nada en Markdown. */
export function normalizeBlankLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const htmlConverter: DocumentConverter = {
  id: "html",
  mimeTypes: ["text/html", "application/xhtml+xml"],
  extensions: [".html", ".htm"],
  convert: (bytes) => Promise.resolve(htmlToMarkdown(bytes.toString("utf8"))),
};
