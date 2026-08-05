/**
 * Conversión a Markdown: el formato canónico intermedio.
 *
 * Todo documento —PDF, DOCX, HTML, CSV— se convierte a Markdown antes de
 * trocearse. A partir de ahí el pipeline es uno solo.
 *
 * El listón de un conversor NO es extraer caracteres: es conservar
 * ENCABEZADOS. El troceador usa la estructura para decidir dónde cortar y para
 * construir las migas de pan de la cita; un conversor que devuelve un muro de
 * texto plano lo deja ciego, y el resultado es un fragmento enorme sin
 * procedencia que recupera mal y cita peor.
 */

export interface ConversionResult {
  markdown: string;
  /** Título detectado, si el formato lo trae. */
  title?: string;
  language?: string;
  pageCount?: number;
  /**
   * Problemas que no impiden la conversión pero degradan el resultado.
   * Se guardan en el documento y se muestran en el panel: un fichero que
   * "cargó bien" y responde mal es peor que uno que falló visiblemente.
   */
  warnings: string[];
}

export interface DocumentConverter {
  readonly id: string;
  readonly mimeTypes: readonly string[];
  readonly extensions: readonly string[];
  convert(bytes: Buffer, filename: string): Promise<ConversionResult>;
}

export class ConversionError extends Error {
  override readonly name = "ConversionError";
  constructor(
    message: string,
    readonly converterId: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Un documento con menos texto que esto no aporta nada recuperable. */
export const MIN_USEFUL_CHARS = 40;

/**
 * Comprobación única de "la extracción salió vacía".
 *
 * Está aquí y no en cada conversor a propósito: es el fallo silencioso clásico
 * de la ingesta. Un PDF escaneado sin OCR extrae cero texto, el documento
 * aparece como cargado en el panel, y no responde nada — sin que nada diga por
 * qué. Un único punto de comprobación es un único test.
 */
export function assessExtraction(result: ConversionResult): ConversionResult {
  const text = result.markdown.replace(/\s+/g, " ").trim();
  const warnings = [...result.warnings];

  if (text.length < MIN_USEFUL_CHARS) {
    warnings.push(
      "La extracción produjo texto insuficiente. Si es un PDF escaneado, " +
        "necesita OCR: tal cual, el documento se cargaría sin responder nada.",
    );
  }

  const headings = (result.markdown.match(/^#{1,6}\s+\S/gm) ?? []).length;
  if (headings === 0 && text.length > 4000) {
    warnings.push(
      "No se detectó ningún encabezado en un documento largo. El troceado " +
        "será por longitud y las citas no tendrán ruta de sección.",
    );
  }

  return { ...result, warnings };
}
