import {
  ProviderError,
  type EmbeddingKind,
  type EmbeddingProvider,
} from "../types.js";

/**
 * Embeddings locales con Transformers.js. Sin clave, sin cuenta, sin límite de
 * peticiones y sin conexión tras la primera descarga.
 *
 * Es un proveedor de PRODUCCIÓN, no un doble de test como el determinista: los
 * vectores son semánticos de verdad, así que el conjunto de evaluación mide
 * calidad real de recuperación y no solo mecánica del pipeline.
 *
 * `multilingual-e5-small` está entrenado en 100 idiomas y rinde bien en
 * español. 384 dimensiones — de ahí la migración 003, que hace convivir varias
 * dimensiones en la misma tabla.
 */

const DIMENSIONS_BY_MODEL: Record<string, number> = {
  "Xenova/multilingual-e5-small": 384,
  "Xenova/multilingual-e5-base": 768,
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2": 384,
};

/**
 * Los modelos E5 exigen prefijo según el uso.
 *
 * No es un detalle cosmético: fueron entrenados con estos prefijos, y omitirlos
 * o intercambiarlos degrada la recuperación de forma medible — sin que nada
 * falle, simplemente recuperando peor.
 *
 * Es también la razón por la que `EmbeddingProvider.embed` recibe `kind` desde
 * el primer commit: la interfaz previó exactamente este caso antes de que
 * existiera un proveedor que lo necesitara.
 */
function prefixFor(model: string, kind: EmbeddingKind): string {
  if (!model.includes("e5")) return "";
  return kind === "query" ? "query: " : "passage: ";
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = "local";
  readonly model: string;
  readonly dimensions: number;

  #pipeline: FeatureExtractor | undefined;
  #loading: Promise<FeatureExtractor> | undefined;

  constructor(opts: { model?: string; dimensions?: number } = {}) {
    this.model = opts.model ?? "Xenova/multilingual-e5-small";

    const known = DIMENSIONS_BY_MODEL[this.model];
    const dimensions = opts.dimensions ?? known;
    if (dimensions === undefined) {
      throw new ProviderError(
        `Dimensión desconocida para ${this.model}: decláradla explícitamente.`,
        "local",
        false,
      );
    }
    this.dimensions = dimensions;
  }

  /**
   * Carga perezosa y una sola vez.
   *
   * El modelo pesa unos 120 MB y se descarga en la primera llamada. Cargarlo en
   * el constructor obligaría a esperar aunque nadie fuese a embeber nada — y el
   * registro de proveedores construye el elegido al arrancar.
   */
  async #ensureLoaded(): Promise<FeatureExtractor> {
    if (this.#pipeline !== undefined) return this.#pipeline;

    this.#loading ??= (async () => {
      try {
        const { pipeline } = (await import("@huggingface/transformers")) as {
          pipeline: (task: string, model: string) => Promise<FeatureExtractor>;
        };
        const extractor = await pipeline("feature-extraction", this.model);
        this.#pipeline = extractor;
        return extractor;
      } catch (error) {
        this.#loading = undefined;
        throw new ProviderError(
          `No se pudo cargar el modelo local ${this.model}. ` +
            "La primera ejecución descarga los pesos y necesita conexión.",
          this.id,
          true,
          error,
        );
      }
    })();

    return this.#loading;
  }

  async embed(texts: string[], kind: EmbeddingKind): Promise<number[][]> {
    if (texts.length === 0) return [];

    const extractor = await this.#ensureLoaded();
    const prefix = prefixFor(this.model, kind);
    const prepared = prefix === "" ? texts : texts.map((t) => prefix + t);

    // `pooling: mean` + `normalize` es la receta estándar de sentence-transformers.
    // Sin normalizar, la distancia coseno de pgvector mide magnitud además de
    // dirección y el orden de resultados cambia sin motivo semántico.
    const output = await extractor(prepared, { pooling: "mean", normalize: true });
    const vectors = output.tolist();

    if (vectors.length !== texts.length) {
      throw new ProviderError(
        `El modelo devolvió ${vectors.length} vectores para ${texts.length} textos`,
        this.id,
        false,
      );
    }

    const first = vectors[0];
    if (first !== undefined && first.length !== this.dimensions) {
      throw new ProviderError(
        `${this.model} produjo ${first.length} dimensiones, no ${this.dimensions}. ` +
          "Un corpus embebido con la dimensión equivocada hay que reindexarlo entero.",
        this.id,
        false,
      );
    }

    return vectors;
  }
}
