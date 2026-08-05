/**
 * La plataforma nunca sabe quién genera el lenguaje ni quién genera los
 * embeddings. Estas dos interfaces son la costura completa (§8 del plan).
 *
 * Regla de costuras: la interfaz existe desde el primer commit con UNA sola
 * implementación real. La segunda llega cuando un caso real la exige — y ese
 * día es un fichero, no un refactor.
 */

// ===========================================================================
// GENERACIÓN DE LENGUAJE
// ===========================================================================

export interface GenerationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerationRequest {
  system?: string;
  messages: GenerationMessage[];
  maxTokens: number;

  /**
   * Profundidad de razonamiento. El nombre es del dominio, no del proveedor:
   * cada adaptador lo traduce a lo que su API entienda, o lo ignora.
   */
  effort?: "low" | "medium" | "high" | "max";

  /**
   * Esquema JSON al que debe ceñirse la salida.
   *
   * Es lo que implementa la capa 5 del grounding: el modelo no devuelve prosa
   * libre sino `{answered, response, citations[]}`, y el validador comprueba
   * las citas en código antes de que nada llegue al usuario.
   */
  outputSchema?: Record<string, unknown>;

  /** Marca el prefijo estable para caché de prompt, si el proveedor la tiene. */
  cacheSystemPrompt?: boolean;

  /**
   * Temperatura, si el proveedor la admite.
   *
   * Deliberadamente opcional y honesta: hay modelos que la RECHAZAN con un
   * error, no que la ignoren. El adaptador consulta `capabilities.sampling`
   * y la descarta cuando no procede — ver §8.1 de este paquete.
   */
  temperature?: number;
}

export interface GenerationResult {
  text: string;
  /** Presente solo si se pidió `outputSchema` y la salida validó. */
  parsed?: unknown;

  stopReason: "end_turn" | "max_tokens" | "refusal" | "other";
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  };
  cost: number;
  model: string;
  latencyMs: number;
}

export interface AIProviderCapabilities {
  toolCalling: boolean;
  structuredOutput: boolean;
  promptCaching: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  /**
   * Si el modelo acepta temperature/top_p. `false` no significa "los ignora":
   * significa que enviarlos es un error. Ver §8.1.
   */
  sampling: boolean;
}

export interface AIProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: AIProviderCapabilities;
  readonly pricing: { inputPerMillion: number; outputPerMillion: number };

  generate(req: GenerationRequest): Promise<GenerationResult>;
}

// ===========================================================================
// EMBEDDINGS
// ===========================================================================

/**
 * `kind` existe porque varios proveedores embeben una consulta y un documento
 * de forma distinta, y usar el modo equivocado degrada la recuperación en
 * silencio: nada falla, solo se recupera peor.
 */
export type EmbeddingKind = "document" | "query";

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  /**
   * Se graba en cada fragmento junto al id del proveedor. Sin eso, cambiar de
   * proveedor obliga a reindexar el corpus de todos los clientes de golpe
   * (§25 del plan).
   */
  readonly dimensions: number;

  embed(texts: string[], kind: EmbeddingKind): Promise<number[][]>;
}

export class ProviderError extends Error {
  override readonly name = "ProviderError";
  constructor(
    message: string,
    readonly providerId: string,
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}
