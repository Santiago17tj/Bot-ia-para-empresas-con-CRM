import { createHash } from "node:crypto";

import type { EmbeddingKind, EmbeddingProvider } from "../types.js";

/**
 * Embeddings deterministas, sin red y sin credenciales.
 *
 * NO es una segunda implementación en el sentido de la regla de costuras: es
 * infraestructura de pruebas. Existe para que el arnés de evaluación y los
 * tests de recuperación corran en CI sin gastar créditos ni depender de que
 * una API de terceros esté disponible.
 *
 * Produce vectores estables por texto — el mismo texto da siempre el mismo
 * vector — y textos que comparten palabras quedan más cerca entre sí, lo que
 * basta para probar que el pipeline recupera, ordena y trunca correctamente.
 * No sirve para medir calidad semántica, y usarlo para eso daría números
 * bonitos y falsos.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly id = "deterministic";
  readonly model = "deterministic-hash-v1";
  readonly dimensions: number;

  constructor(opts: { dimensions?: number } = {}) {
    this.dimensions = opts.dimensions ?? 1536;
  }

  embed(texts: string[], _kind: EmbeddingKind): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.#vectorFor(text)));
  }

  #vectorFor(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);

    // Bolsa de palabras con hash: cada token suma en una posición fija, así
    // que dos textos con vocabulario común apuntan en direcciones parecidas.
    const tokens = text.toLowerCase().match(/\p{L}+|\p{N}+/gu) ?? [];
    for (const token of tokens) {
      const digest = createHash("sha256").update(token).digest();
      const slot = digest.readUInt32BE(0) % this.dimensions;
      const sign = (digest[4] as number) % 2 === 0 ? 1 : -1;
      vector[slot] = (vector[slot] as number) + sign;
    }

    // Normalizado para que la similitud coseno se comporte como en un
    // proveedor real. Un texto sin tokens da el vector cero, que es honesto:
    // no se parece a nada.
    let norm = 0;
    for (const value of vector) norm += value * value;
    if (norm === 0) return vector;

    const inverse = 1 / Math.sqrt(norm);
    return vector.map((value) => value * inverse);
  }
}
