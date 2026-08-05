import { normalizeBlankLines } from "./html.js";
import type { ConversionResult, DocumentConverter } from "./types.js";

/** Markdown: pasa tal cual, solo se normalizan los saltos. */
export const markdownConverter: DocumentConverter = {
  id: "markdown",
  mimeTypes: ["text/markdown", "text/x-markdown"],
  extensions: [".md", ".markdown"],
  convert: (bytes) =>
    Promise.resolve({
      markdown: normalizeBlankLines(bytes.toString("utf8")),
      warnings: [],
    }),
};

/**
 * Texto plano → Markdown, infiriendo encabezados.
 *
 * Sin esta inferencia, un .txt entero es una sola sección y las citas salen sin
 * ruta. Las heurísticas son deliberadamente conservadoras: marcar de más
 * inventa una estructura que el documento no tiene, y eso trocea por sitios
 * arbitrarios.
 */
export function textToMarkdown(text: string): ConversionResult {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trimEnd();
    const trimmed = line.trim();

    if (trimmed === "") {
      out.push("");
      continue;
    }

    // Subrayado con === o ---, la convención de texto plano de toda la vida.
    const next = (lines[i + 1] ?? "").trim();
    if (/^={3,}$/.test(next)) {
      out.push(`# ${trimmed}`);
      i++;
      continue;
    }
    if (/^-{3,}$/.test(next)) {
      out.push(`## ${trimmed}`);
      i++;
      continue;
    }

    // Numeración jerárquica: "1." nivel 2, "1.2." nivel 3.
    const numbered = /^(\d+(?:\.\d+)*)\.?\s+(\S.*)$/.exec(trimmed);
    if (numbered !== undefined && numbered !== null && trimmed.length < 90) {
      const depth = (numbered[1] as string).split(".").filter(Boolean).length;
      out.push(`${"#".repeat(Math.min(depth + 1, 6))} ${numbered[2] as string}`);
      continue;
    }

    // Línea corta en MAYÚSCULAS aislada entre blancos.
    const previous = (lines[i - 1] ?? "").trim();
    const isolated = previous === "" && next === "";
    if (
      isolated &&
      trimmed.length < 70 &&
      trimmed === trimmed.toUpperCase() &&
      /\p{Lu}/u.test(trimmed) &&
      !/[.:;]$/.test(trimmed)
    ) {
      out.push(`## ${toTitleCase(trimmed)}`);
      continue;
    }

    out.push(line);
  }

  const markdown = normalizeBlankLines(out.join("\n"));
  if (!/^#{1,6}\s/m.test(markdown) && markdown.length > 4000) {
    warnings.push(
      "No se pudo inferir estructura del texto plano: el troceado será por longitud.",
    );
  }

  return { markdown, warnings };
}

function toTitleCase(text: string): string {
  return text
    .toLocaleLowerCase("es")
    .replace(/(^|\s)(\p{L})/gu, (_m, space: string, letter: string) =>
      space + letter.toLocaleUpperCase("es"),
    );
}

export const textConverter: DocumentConverter = {
  id: "text",
  mimeTypes: ["text/plain"],
  extensions: [".txt", ".text"],
  convert: (bytes) => Promise.resolve(textToMarkdown(bytes.toString("utf8"))),
};

/**
 * CSV → tabla Markdown.
 *
 * Una tabla se conserva como tabla porque sus celdas solo significan algo junto
 * a su cabecera. Aplanada a prosa, el fragmento con las cifras pierde qué son
 * — se recupera igual de bien y responde mal.
 */
export function csvToMarkdown(csv: string, delimiter = ","): ConversionResult {
  const rows = parseCsv(csv, delimiter);
  const warnings: string[] = [];

  if (rows.length === 0) return { markdown: "", warnings };

  const header = rows[0] as string[];
  const body = rows.slice(1);
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => {
      const cells = [...row];
      // Se rellenan filas cortas: una tabla Markdown con filas desiguales se
      // renderiza mal y desalinea las columnas al leerla.
      while (cells.length < header.length) cells.push("");
      return `| ${cells.slice(0, header.length).join(" | ")} |`;
    }),
  ];

  if (body.some((row) => row.length !== header.length)) {
    warnings.push("Algunas filas del CSV no tenían el mismo número de columnas.");
  }

  return { markdown: lines.join("\n"), warnings };
}

/** Parser CSV con comillas y saltos dentro de celda. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n") {
      row.push(cell.trim());
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some((c) => c !== "")) rows.push(row);

  return rows;
}

export const csvConverter: DocumentConverter = {
  id: "csv",
  mimeTypes: ["text/csv", "application/csv"],
  extensions: [".csv"],
  convert: (bytes) => Promise.resolve(csvToMarkdown(bytes.toString("utf8"))),
};
