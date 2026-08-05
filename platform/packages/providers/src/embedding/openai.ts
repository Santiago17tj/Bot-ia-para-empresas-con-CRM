import {
  ProviderError,
  type EmbeddingKind,
  type EmbeddingProvider,
} from "../types.js";

/**
 * Embeddings vía la API de OpenAI.
 *
 * Se usa `fetch` en vez del SDK a propósito: el endpoint de embeddings es un
 * POST con un JSON de tres campos, y una dependencia entera para eso es peso
 * muerto en una interfaz cuyo objetivo es ser sustituible.
 */

const DIMENSIONS_BY_MODEL: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

interface OpenAIEmbeddingResponse {
  data: { index: number; embedding: number[] }[];
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai";
  readonly model: string;
  readonly dimensions: number;

  readonly #apiKey: string;
  readonly #baseUrl: string;

  constructor(opts: {
    apiKey: string;
    model?: string;
    dimensions?: number;
    baseUrl?: string;
  }) {
    this.#apiKey = opts.apiKey;
    this.model = opts.model ?? "text-embedding-3-small";
    this.#baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";

    const known = DIMENSIONS_BY_MODEL[this.model];
    const dimensions = opts.dimensions ?? known;
    if (dimensions === undefined) {
      throw new ProviderError(
        `Dimensión desconocida para ${this.model}: decláradla explícitamente. ` +
          "Adivinarla es peor que fallar — un corpus embebido con la dimensión " +
          "equivocada hay que reindexarlo entero.",
        "openai",
        false,
      );
    }
    this.dimensions = dimensions;
  }

  async embed(texts: string[], _kind: EmbeddingKind): Promise<number[][]> {
    if (texts.length === 0) return [];

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          dimensions: this.dimensions,
        }),
      });
    } catch (error) {
      throw new ProviderError(
        "No se pudo contactar con la API de embeddings",
        this.id,
        true,
        error,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ProviderError(
        `La API de embeddings devolvió ${response.status}: ${body.slice(0, 300)}`,
        this.id,
        response.status === 429 || response.status >= 500,
      );
    }

    const payload = (await response.json()) as OpenAIEmbeddingResponse;

    // El orden de `data` no está garantizado; cada elemento trae su `index`.
    // Confiar en el orden de llegada desalinearía los vectores de sus textos,
    // que es un fallo silencioso: la búsqueda simplemente devuelve otra cosa.
    const out = new Array<number[] | undefined>(texts.length);
    for (const item of payload.data) out[item.index] = item.embedding;

    return out.map((vector, i) => {
      if (vector === undefined) {
        throw new ProviderError(
          `La respuesta no incluyó embedding para el texto ${i}`,
          this.id,
          true,
        );
      }
      return vector;
    });
  }
}
