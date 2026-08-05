/**
 * Traducción dimensión → columna de vector.
 *
 * Es el único sitio del sistema que sabe en qué columna vive cada vector. La
 * ingesta escribe consultando esta tabla y la búsqueda lee consultándola, así
 * que las dos no pueden discrepar — y discrepar sería el peor fallo posible
 * aquí: se escribiría en una columna y se buscaría en otra, sin error, con la
 * búsqueda devolviendo siempre vacío.
 */

export const EMBEDDING_COLUMNS: Record<number, string> = {
  384: "embedding_384",
  1536: "embedding",
};

export class UnsupportedDimensionError extends Error {
  override readonly name = "UnsupportedDimensionError";
}

/**
 * Falla ruidosamente ante una dimensión no registrada.
 *
 * La alternativa —caer a la columna por defecto— insertaría un vector de 384 en
 * una columna de 1536. Postgres lo rechaza, que ya es mejor que el caso
 * silencioso; pero si las dimensiones coincidieran por casualidad, se estaría
 * mezclando el espacio vectorial de dos modelos distintos y la búsqueda
 * devolvería resultados plausibles y equivocados para siempre.
 */
export function columnForDimensions(dimensions: number): string {
  const column = EMBEDDING_COLUMNS[dimensions];
  if (column === undefined) {
    throw new UnsupportedDimensionError(
      `No hay columna registrada para ${dimensions} dimensiones. ` +
        `Registradas: ${Object.keys(EMBEDDING_COLUMNS).join(", ")}. ` +
        "Añade la columna con una migración SQL y regístrala aquí — hacer una " +
        "sola de las dos cosas escribe vectores que nadie leerá.",
    );
  }
  return column;
}

export function supportedDimensions(): number[] {
  return Object.keys(EMBEDDING_COLUMNS).map(Number);
}
