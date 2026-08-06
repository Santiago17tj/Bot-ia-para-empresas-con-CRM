/**
 * Troceado con estructura (§5.2 del plan).
 *
 * Se respeta la estructura (encabezados, secciones) ANTES que la longitud fija.
 * Un troceado ciego por caracteres parte una tabla de precios por la mitad y
 * deja un fragmento con las cifras sin la cabecera que dice qué son — se
 * recupera perfectamente y responde mal.
 */

export interface ChunkInput {
  text: string;
  /** Ruta de encabezados hasta aquí: ["Garantías", "Devoluciones"]. */
  breadcrumbs: string[];
  pageNumber?: number;
}

export interface ChunkOptions {
  /** Objetivo en tokens. Ni el mínimo ni el máximo: hacia donde se apunta. */
  targetTokens?: number;
  maxTokens?: number;
  /** Solape entre fragmentos contiguos, en tokens. */
  overlapTokens?: number;
  minTokens?: number;
}

export interface Chunk {
  content: string;
  tokenCount: number;
  ordinal: number;
  breadcrumbs: string[];
  pageNumber?: number;
  sectionPath?: string;
}

const DEFAULTS: Required<Omit<ChunkOptions, never>> = {
  targetTokens: 600,
  maxTokens: 900,
  overlapTokens: 90,
  minTokens: 60,
};

/** Misma estimación conservadora que el Context Engine, por coherencia. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Parte un documento Markdown en secciones por encabezado, conservando la ruta.
 *
 * Los `breadcrumbs` no son decoración: son lo que permite que la cita diga
 * "Manual de garantías › Devoluciones › Plazo" en vez de "fragmento 47", y lo
 * que da al modelo el contexto que el troceo le quitó.
 */
export function pageMarker(page: number): string {
  return `<!--page:${page}-->`;
}

const PAGE_MARKER = /^<!--page:(\d+)-->$/;

export function splitByHeadings(markdown: string): ChunkInput[] {
  const lines = markdown.split(/\r?\n/);
  const sections: ChunkInput[] = [];

  // Página en curso. Los conversores que saben de páginas —hoy el de PDF—
  // insertan `<!--page:N-->` y aquí se convierte en el `pageNumber` del
  // fragmento. Sin esto, `pageNumber` estaba declarado en el tipo desde el
  // primer día y no lo rellenaba nadie: la cita de un manual de 300 páginas
  // decía de qué sección venía pero no de qué página, que es justo el dato con
  // el que una persona va a comprobarlo.
  //
  // El marcador es un comentario HTML porque atraviesa el Markdown sin
  // renderizarse y no puede confundirse con contenido del documento.
  let currentPage: number | undefined;
  let sectionPage: number | undefined;

  // Indexado POR NIVEL, no por posición en la ruta. Usar la posición asume que
  // el documento empieza en `#`, y muchos empiezan en `##`: entonces un `##`
  // nuevo heredaba el `##` anterior en vez de reemplazarlo, y la cita decía
  // "Envíos › Devoluciones" para una sección que solo era "Devoluciones".
  const byLevel: (string | undefined)[] = [];
  let buffer: string[] = [];

  const currentPath = (): string[] =>
    byLevel.filter((title): title is string => title !== undefined);

  const flush = (): void => {
    const text = buffer.join("\n").trim();
    if (text.length > 0) {
      sections.push({
        text,
        breadcrumbs: currentPath(),
        // La página donde EMPIEZA la sección, no donde termina: una sección que
        // cruza un salto de página se cita por donde el lector la va a buscar.
        ...(sectionPage === undefined ? {} : { pageNumber: sectionPage }),
      });
    }
    buffer = [];
    sectionPage = currentPage;
  };

  for (const line of lines) {
    const page = PAGE_MARKER.exec(line.trim());
    if (page !== null) {
      currentPage = Number(page[1]);
      // Si la sección aún no tiene contenido, empieza en esta página. Si ya lo
      // tiene, el marcador solo actualiza dónde empezará la SIGUIENTE.
      if (buffer.join("").trim() === "") sectionPage = currentPage;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading === null) {
      buffer.push(line);
      continue;
    }

    flush();
    const level = (heading[1] as string).length;
    byLevel[level] = (heading[2] as string).trim();
    // Un encabezado cierra todos los subniveles abiertos por debajo de él.
    for (let deeper = level + 1; deeper < byLevel.length; deeper++) {
      byLevel[deeper] = undefined;
    }
  }
  flush();

  // El respaldo también limpia marcadores: un documento sin encabezados no
  // debe acabar con `<!--page:3-->` incrustado en el texto que se embebe y que
  // luego se le enseña al modelo.
  return sections.length > 0
    ? sections
    : [
        {
          text: markdown.replace(/^<!--page:\d+-->$/gm, "").trim(),
          breadcrumbs: [],
        },
      ];
}

/**
 * Trocea una sección respetando límites de párrafo y frase.
 *
 * El orden de preferencia al cortar es: párrafo → frase → palabra. Cortar a
 * mitad de palabra es lo único que nunca se hace, porque destruye el término
 * que probablemente era la clave de la búsqueda.
 */
function splitSection(text: string, opts: Required<ChunkOptions>): string[] {
  if (estimateTokens(text) <= opts.maxTokens) return [text];

  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const pieces: string[] = [];
  let current = "";

  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) pieces.push(trimmed);
    current = "";
  };

  for (const paragraph of paragraphs) {
    const candidate = current === "" ? paragraph : `${current}\n\n${paragraph}`;

    if (estimateTokens(candidate) <= opts.targetTokens) {
      current = candidate;
      continue;
    }

    push();

    if (estimateTokens(paragraph) <= opts.maxTokens) {
      current = paragraph;
      continue;
    }

    // Un párrafo solo ya excede el máximo: se parte por frases.
    for (const sentence of splitSentences(paragraph)) {
      // Una "frase" puede seguir siendo enorme: un PDF mal extraído llega como
      // un muro de texto sin saltos de párrafo NI puntos finales. Sin este
      // corte duro, ese documento producía un único fragmento de miles de
      // tokens que ni cabe en el contexto ni recupera nada útil — y no fallaba,
      // simplemente respondía mal.
      for (const piece of hardSplit(sentence, opts.maxTokens)) {
        const withPiece = current === "" ? piece : `${current} ${piece}`;
        if (estimateTokens(withPiece) > opts.targetTokens) {
          push();
          current = piece;
        } else {
          current = withPiece;
        }
      }
    }
  }
  push();

  return pieces;
}

/**
 * Último recurso: parte por palabras cuando no hay párrafo ni frase donde
 * cortar. Nunca parte a mitad de palabra — eso destruiría el término que
 * probablemente era la clave de la búsqueda.
 */
function hardSplit(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];

  const words = text.split(/(\s+)/);
  const pieces: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current + word;
    if (current !== "" && estimateTokens(candidate) > maxTokens) {
      pieces.push(current.trim());
      current = word.trimStart();
    } else {
      current = candidate;
    }
  }

  const tail = current.trim();
  if (tail.length > 0) pieces.push(tail);

  return pieces;
}

/**
 * Segmenta por frases teniendo en cuenta abreviaturas frecuentes en español.
 *
 * Sin esto, "Sr. García" o "Ref. AX-4402" parten el fragmento en el punto de la
 * abreviatura y dejan la referencia huérfana — justo el identificador que la
 * búsqueda léxica necesitaba entero.
 */
export function splitSentences(text: string): string[] {
  const ABBREVIATIONS = /\b(Sr|Sra|Srta|Dr|Dra|Ref|Art|Núm|Nº|Av|Ud|Uds|etc|pág|vol|ej)\.$/i;

  const parts = text.split(/(?<=[.!?])\s+/);
  const sentences: string[] = [];

  for (const part of parts) {
    const previous = sentences[sentences.length - 1];
    if (previous !== undefined && ABBREVIATIONS.test(previous)) {
      sentences[sentences.length - 1] = `${previous} ${part}`;
    } else {
      sentences.push(part);
    }
  }

  return sentences.filter((s) => s.trim().length > 0);
}

/**
 * Añade solape con el final del fragmento anterior.
 *
 * El solape existe porque una respuesta puede caer justo en la costura entre
 * dos fragmentos. Sin él, la frase que contesta la pregunta queda partida y
 * ninguno de los dos fragmentos la contiene entera.
 */
function withOverlap(pieces: string[], overlapTokens: number): string[] {
  if (overlapTokens <= 0 || pieces.length <= 1) return pieces;

  const overlapChars = Math.round(overlapTokens * 3.5);

  return pieces.map((piece, i) => {
    if (i === 0) return piece;
    const previous = pieces[i - 1] as string;
    const tail = previous.slice(-overlapChars);
    // Se empieza el solape en un límite de palabra: cortar a media palabra
    // introduce un token basura al principio de cada fragmento.
    const boundary = tail.search(/\s/);
    const clean = boundary === -1 ? tail : tail.slice(boundary + 1);
    return clean.length > 0 ? `${clean}\n\n${piece}` : piece;
  });
}

/**
 * Trocea un documento completo.
 *
 * Los fragmentos por debajo de `minTokens` se fusionan con el siguiente: un
 * fragmento de ocho palabras casi nunca contesta nada y ensucia la
 * recuperación ocupando un puesto en el top-k.
 */
export function chunkDocument(
  markdown: string,
  options: ChunkOptions = {},
): Chunk[] {
  const merged = { ...DEFAULTS, ...options };
  // `targetTokens` nunca puede superar `maxTokens`: quien pasa solo el máximo
  // espera que el objetivo lo respete, y al revés el objetivo ganaría y el
  // máximo declarado sería mentira.
  const opts = {
    ...merged,
    targetTokens: Math.min(merged.targetTokens, merged.maxTokens),
  };
  const sections = splitByHeadings(markdown);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const pieces = withOverlap(splitSection(section.text, opts), opts.overlapTokens);

    for (const piece of pieces) {
      const tokenCount = estimateTokens(piece);
      const previous = chunks[chunks.length - 1];

      if (
        tokenCount < opts.minTokens &&
        previous !== undefined &&
        previous.breadcrumbs.join("›") === section.breadcrumbs.join("›") &&
        previous.tokenCount + tokenCount <= opts.maxTokens
      ) {
        previous.content = `${previous.content}\n\n${piece}`;
        previous.tokenCount = estimateTokens(previous.content);
        continue;
      }

      chunks.push({
        content: piece,
        tokenCount,
        ordinal: chunks.length,
        breadcrumbs: section.breadcrumbs,
        ...(section.pageNumber !== undefined ? { pageNumber: section.pageNumber } : {}),
        ...(section.breadcrumbs.length > 0
          ? { sectionPath: section.breadcrumbs.join(" › ") }
          : {}),
      });
    }
  }

  return chunks.map((chunk, ordinal) => ({ ...chunk, ordinal }));
}
