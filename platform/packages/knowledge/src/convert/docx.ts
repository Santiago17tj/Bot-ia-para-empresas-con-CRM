import { htmlToMarkdown } from "./html.js";
import { ConversionError, type ConversionResult, type DocumentConverter } from "./types.js";

/**
 * DOCX → Markdown, pasando por HTML.
 *
 * El rodeo es deliberado y es lo que hace bueno a este conversor. Un `.docx`
 * lleva la estructura DENTRO —«Título 1», «Título 2», listas, tablas— y mammoth
 * la traduce a HTML semántico: `<h1>`, `<h2>`, `<ul>`, `<table>`. A partir de
 * ahí reutilizamos `htmlToMarkdown`, que ya está escrito y probado.
 *
 * La alternativa —leer el XML de OOXML a mano— habría sido un segundo camino
 * que mantener para llegar al mismo Markdown, y el primero que se quedaría
 * atrás el día que se mejore el manejo de tablas.
 *
 * A diferencia del PDF, aquí NO hay que inferir nada: los encabezados son
 * encabezados de verdad, así que las citas salen con su ruta de sección
 * correcta sin heurística de por medio.
 */

interface MammothResult {
  value: string;
  messages: { type: string; message: string }[];
}

export const docxConverter: DocumentConverter = {
  id: "docx",
  mimeTypes: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  extensions: [".docx"],
  convert: async (bytes, filename) => convertDocx(bytes, filename),
};

async function convertDocx(bytes: Buffer, filename: string): Promise<ConversionResult> {
  const mammoth = (await import("mammoth")) as unknown as {
    default?: { convertToHtml(input: { buffer: Buffer }): Promise<MammothResult> };
    convertToHtml?(input: { buffer: Buffer }): Promise<MammothResult>;
  };

  const convertToHtml = mammoth.convertToHtml ?? mammoth.default?.convertToHtml;
  if (convertToHtml === undefined) {
    throw new ConversionError("mammoth no expone convertToHtml", "docx");
  }

  let result: MammothResult;
  try {
    result = await convertToHtml({ buffer: bytes });
  } catch (error) {
    throw new ConversionError(
      `No se pudo leer "${filename}" como DOCX: ${describe(error)}. ` +
        "El formato .doc antiguo (Word 97-2003) no vale: hay que guardarlo como .docx.",
      "docx",
      error,
    );
  }

  const converted = htmlToMarkdown(result.value);

  // Los avisos de mammoth se conservan porque describen pérdidas reales:
  // «unrecognised paragraph style» significa que un encabezado con estilo
  // propio del cliente llegó como párrafo normal, y eso se nota luego en unas
  // citas sin ruta de sección que nadie sabría explicar.
  const warnings = [
    ...converted.warnings,
    ...result.messages
      .filter((message) => message.type === "warning")
      .map((message) => `DOCX: ${message.message}`),
  ];

  return { ...converted, warnings };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
