import { extname } from "node:path";

import { docxConverter } from "./docx.js";
import { htmlConverter } from "./html.js";
import { pdfConverter } from "./pdf.js";
import { csvConverter, markdownConverter, textConverter } from "./text.js";
import {
  ConversionError,
  assessExtraction,
  type ConversionResult,
  type DocumentConverter,
} from "./types.js";

/**
 * Registro de conversores.
 *
 * Añadir un formato es un fichero y una entrada aquí. Todo lo de abajo —
 * troceado, embeddings, recuperación, citas — no cambia, porque a partir del
 * Markdown el pipeline es uno solo.
 */
const CONVERTERS: DocumentConverter[] = [
  markdownConverter,
  textConverter,
  htmlConverter,
  csvConverter,
  pdfConverter,
  docxConverter,
];

export function registerConverter(converter: DocumentConverter): void {
  const existing = CONVERTERS.findIndex((c) => c.id === converter.id);
  if (existing >= 0) CONVERTERS[existing] = converter;
  else CONVERTERS.push(converter);
}

export function availableFormats(): { id: string; extensions: readonly string[] }[] {
  return CONVERTERS.map((c) => ({ id: c.id, extensions: c.extensions }));
}

/**
 * Resuelve el conversor por MIME y, si no, por extensión.
 *
 * El MIME manda porque un `.txt` que en realidad es HTML se convierte mejor
 * como HTML. La extensión es el respaldo, porque muchos clientes suben todo
 * como `application/octet-stream`.
 */
export function converterFor(
  filename: string,
  mimeType?: string,
): DocumentConverter | undefined {
  if (mimeType !== undefined) {
    const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
    const byMime = CONVERTERS.find((c) => c.mimeTypes.includes(base));
    if (byMime !== undefined) return byMime;
  }

  const ext = extname(filename).toLowerCase();
  return CONVERTERS.find((c) => c.extensions.includes(ext));
}

/**
 * Convierte cualquier documento soportado a Markdown.
 *
 * Toda conversión pasa por `assessExtraction`, que es el único sitio donde se
 * comprueba que salió texto útil. Un PDF escaneado sin OCR extrae cero
 * caracteres: sin esa comprobación el documento aparece cargado en el panel y
 * no responde nada, y nada dice por qué.
 */
export async function toMarkdown(
  bytes: Buffer,
  filename: string,
  mimeType?: string,
): Promise<ConversionResult> {
  const converter = converterFor(filename, mimeType);

  if (converter === undefined) {
    const formats = availableFormats()
      .flatMap((f) => f.extensions)
      .join(", ");
    throw new ConversionError(
      `No hay conversor para "${filename}" (${mimeType ?? "sin MIME"}). Soportados: ${formats}`,
      "registry",
    );
  }

  try {
    const result = await converter.convert(bytes, filename);
    return assessExtraction(result);
  } catch (error) {
    if (error instanceof ConversionError) throw error;
    throw new ConversionError(
      `El conversor "${converter.id}" falló con ${filename}: ` +
        (error instanceof Error ? error.message : String(error)),
      converter.id,
      error,
    );
  }
}

export { ConversionError, assessExtraction, MIN_USEFUL_CHARS } from "./types.js";
export type { ConversionResult, DocumentConverter } from "./types.js";
export { htmlToMarkdown, decodeEntities, normalizeBlankLines } from "./html.js";
export { textToMarkdown, csvToMarkdown, parseCsv } from "./text.js";

export { pdfConverter, mostFrequentHeight, distinctHeadingHeights } from "./pdf.js";
export { docxConverter } from "./docx.js";
