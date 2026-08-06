import { pageMarker } from "../chunking.js";
import { ConversionError, type ConversionResult, type DocumentConverter } from "./types.js";

/**
 * PDF → Markdown.
 *
 * **Un PDF no tiene encabezados.** No es una limitación de la librería: el
 * formato describe glifos en coordenadas, no estructura. «Cobertura» en negrita
 * a 16 puntos y un párrafo a 11 son, para el fichero, la misma clase de cosa.
 *
 * Y el listón de un conversor aquí es conservar encabezados, porque el
 * troceador corta por ellos y las citas se construyen con ellos. Extraer el
 * texto y devolver un muro plano cumpliría la firma y produciría exactamente lo
 * que este pipeline existe para no tener: un fragmento gigante sin procedencia
 * que se recupera mal y se cita peor.
 *
 * Así que se infiere la estructura de lo único que el PDF sí dice: el TAMAÑO de
 * cada línea. Se calcula el cuerpo del texto —la altura más frecuente, no la
 * media, porque un título enorme arrastraría la media— y lo que sobresale de
 * forma clara se promueve a encabezado, con el nivel dado por su tamaño
 * relativo.
 *
 * Es una heurística y se comporta como tal: acierta en el documento maquetado
 * con estilos y falla en el que usa el mismo cuerpo para todo. Cuando no
 * encuentra ni un encabezado lo dice en los avisos, en vez de dejar creer que
 * el documento estaba bien estructurado.
 */

/** Cuánto tiene que sobresalir una línea del cuerpo para ser encabezado. */
const HEADING_RATIO = 1.15;

/** Alturas más juntas que esto se consideran el mismo nivel. */
const LEVEL_TOLERANCE = 0.5;

interface TextItem {
  str: string;
  transform: number[];
  hasEOL?: boolean;
}

interface Line {
  text: string;
  height: number;
  page: number;
}

export const pdfConverter: DocumentConverter = {
  id: "pdf",
  mimeTypes: ["application/pdf"],
  extensions: [".pdf"],
  convert: async (bytes, filename) => convertPdf(bytes, filename),
};

async function convertPdf(bytes: Buffer, filename: string): Promise<ConversionResult> {
  const warnings: string[] = [];

  // La compilación `legacy` es la que funciona en Node sin DOM. La moderna
  // asume APIs de navegador y falla al cargar, no al usarse.
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as {
    getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocument> };
  };

  let document: PdfDocument;
  try {
    document = await pdfjs.getDocument({
      // Copia: pdfjs se APROPIA del buffer que recibe y lo deja vacío. Pasar el
      // original directamente hace que el llamante se quede sin bytes, y el
      // checksum posterior se calcularía sobre nada.
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      // Sin worker: en Node no aporta paralelismo real y complica el empaquetado.
      isEvalSupported: false,
    }).promise;
  } catch (error) {
    throw new ConversionError(
      `No se pudo abrir "${filename}" como PDF: ${describe(error)}. ` +
        "Si está protegido con contraseña, hay que quitarla antes de subirlo.",
      "pdf",
      error,
    );
  }

  const lines: Line[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    lines.push(...linesOf(content.items, pageNumber));
  }

  if (lines.length === 0) {
    // No se lanza: `assessExtraction` ya avisa de la extracción vacía con un
    // mensaje que menciona el OCR, y devolver un documento vacío con aviso es
    // más útil que un error que no dice qué hacer.
    return { markdown: "", pageCount: document.numPages, warnings };
  }

  const bodyHeight = mostFrequentHeight(lines);
  const headingHeights = distinctHeadingHeights(lines, bodyHeight);

  if (headingHeights.length === 0) {
    warnings.push(
      "Ningún texto sobresale del cuerpo: este PDF usa el mismo tamaño para " +
        "todo, así que no se pudo inferir su estructura. El troceado será por " +
        "longitud y las citas no llevarán ruta de sección.",
    );
  }

  const markdown = render(lines, bodyHeight, headingHeights);
  const title = firstHeading(markdown);

  return {
    markdown,
    ...(title === undefined ? {} : { title }),
    pageCount: document.numPages,
    warnings,
  };
}

/**
 * Agrupa los fragmentos sueltos de una página en líneas.
 *
 * pdfjs devuelve trozos, no líneas: una sola frase puede venir partida en cinco
 * fragmentos porque cambió la fuente a mitad. Se agrupan por su coordenada Y
 * —redondeada, porque los acentos y los subíndices la desplazan un poco— y se
 * ordenan de arriba abajo, que es el orden en que se lee.
 */
function linesOf(items: unknown[], page: number): Line[] {
  const byRow = new Map<number, { parts: { x: number; str: string }[]; height: number }>();

  for (const raw of items) {
    const item = raw as TextItem;
    if (typeof item.str !== "string" || item.str.trim() === "") continue;

    const transform = item.transform;
    const x = transform[4] ?? 0;
    const y = transform[5] ?? 0;
    // `transform[3]` es la escala vertical de la fuente: su altura efectiva.
    const height = Math.abs(transform[3] ?? 0);

    const row = Math.round(y);
    const existing = byRow.get(row);

    if (existing === undefined) {
      byRow.set(row, { parts: [{ x, str: item.str }], height });
    } else {
      existing.parts.push({ x, str: item.str });
      // La altura de la línea es la de su texto más grande: si una línea mezcla
      // un número en superíndice con el título, manda el título.
      existing.height = Math.max(existing.height, height);
    }
  }

  return [...byRow.entries()]
    // Y decreciente: en PDF el origen está abajo, así que arriba es mayor.
    .sort((a, b) => b[0] - a[0])
    .map(([, row]) => ({
      text: row.parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.str)
        .join("")
        .replace(/\s+/g, " ")
        .trim(),
      height: row.height,
      page,
    }))
    .filter((line) => line.text !== "");
}

/**
 * La altura del cuerpo del texto: la MODA, no la media.
 *
 * Se pondera por cantidad de caracteres y no por número de líneas, porque un
 * documento con veinte titulares cortos y cinco párrafos largos tiene más
 * líneas de titular que de cuerpo, y la moda por líneas elegiría el titular
 * como cuerpo — invirtiendo la jerarquía entera.
 */
export function mostFrequentHeight(lines: { text: string; height: number }[]): number {
  const weight = new Map<number, number>();

  for (const line of lines) {
    const bucket = Math.round(line.height * 2) / 2;
    weight.set(bucket, (weight.get(bucket) ?? 0) + line.text.length);
  }

  let best = 0;
  let bestWeight = -1;
  for (const [height, chars] of weight) {
    if (chars > bestWeight) {
      best = height;
      bestWeight = chars;
    }
  }

  return best;
}

/** Alturas que superan el cuerpo, de mayor a menor y sin duplicados cercanos. */
export function distinctHeadingHeights(
  lines: { text: string; height: number }[],
  bodyHeight: number,
): number[] {
  const candidates = [
    ...new Set(
      lines
        .filter((line) => line.height >= bodyHeight * HEADING_RATIO)
        .map((line) => Math.round(line.height * 2) / 2),
    ),
  ].sort((a, b) => b - a);

  const levels: number[] = [];
  for (const height of candidates) {
    const last = levels[levels.length - 1];
    if (last === undefined || last - height > LEVEL_TOLERANCE) levels.push(height);
  }

  // Markdown tiene seis niveles. Más allá, los tamaños restantes se agrupan en
  // el sexto en vez de inventar un `#######` que ningún parser entiende.
  return levels.slice(0, 6);
}

function render(lines: Line[], bodyHeight: number, headingHeights: number[]): string {
  const out: string[] = [];
  let lastPage = 0;

  for (const line of lines) {
    if (line.page !== lastPage) {
      out.push(pageMarker(line.page));
      lastPage = line.page;
    }

    const level = headingHeights.findIndex(
      (height) => Math.abs(height - Math.round(line.height * 2) / 2) <= LEVEL_TOLERANCE,
    );

    if (level >= 0 && line.height >= bodyHeight * HEADING_RATIO) {
      out.push("", `${"#".repeat(level + 1)} ${line.text}`, "");
    } else {
      out.push(line.text);
    }
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstHeading(markdown: string): string | undefined {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
}
