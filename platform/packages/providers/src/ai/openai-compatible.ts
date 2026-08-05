import {
  ProviderError,
  type AIProvider,
  type AIProviderCapabilities,
  type GenerationRequest,
  type GenerationResult,
} from "../types.js";

/**
 * Segundo adaptador del puerto `AIProvider`. Habla el protocolo
 * `POST /v1/chat/completions` de OpenAI — que NO es el de OpenAI, es la lingua
 * franca de casi todo lo demás.
 *
 * Por qué esto y no "un adaptador para Groq":
 *
 * Groq, Ollama, vLLM, LM Studio, Together, OpenRouter y DeepSeek exponen el
 * mismo cuerpo de petición. Elegir entre Groq y Ollama no era una decisión de
 * arquitectura: es una URL base. La decisión de arquitectura era **qué
 * protocolo habla el segundo adaptador**, y la respuesta correcta a largo plazo
 * es el que además resuelve el caso on-premise — la clínica que no puede sacar
 * los datos de su edificio apunta esto a un vLLM suyo y no cambia una línea.
 *
 * No usa SDK a propósito. El protocolo es HTTP y un `fetch`; una dependencia
 * aquí solo añadiría una versión que mantener por cada backend.
 *
 * `@anthropic-ai/sdk` no aparece en este fichero y `openai` tampoco: la costura
 * sigue intacta, ahora con dos implementaciones en vez de una.
 */

// ===========================================================================
// PERFILES DE BACKEND
// ===========================================================================

/**
 * Cómo obliga cada backend a que la salida se ciña a un esquema.
 *
 *  - `json_schema`: el servidor valida contra el esquema. Es el único modo que
 *    convierte "por favor cita" en una garantía.
 *  - `json_object`: el servidor garantiza JSON válido y NADA sobre su forma.
 *  - `none`: no hay salida estructurada.
 *
 * La diferencia entre los dos primeros parece de grado y no lo es. Con
 * `json_object` el modelo devuelve JSON que puede no tener `citations`, y el
 * fallo no es ruidoso: es una respuesta bien formada y sin fundar. Por eso
 * `capabilities.structuredOutput` es `true` SOLO con `json_schema` — la
 * capacidad que el resto del sistema consulta es "¿puedo exigir citas?", no
 * "¿me devolverá algo parseable?".
 */
export type StructuredOutputMode = "json_schema" | "json_object" | "none";

export interface BackendProfile {
  /** Base sin `/chat/completions`. Ej.: `https://api.groq.com/openai/v1`. */
  baseUrl: string;
  defaultModel: string;
  /** Nombre de la variable de entorno con la clave, si el backend la exige. */
  apiKeyEnv: string | undefined;
  structuredOutput: StructuredOutputMode;
  /**
   * Modelos que SÍ admiten `json_schema`, cuando la capacidad es del modelo y
   * no del servidor.
   *
   * En Groq lo es: `llama-3.3-70b-versatile` responde 400 con
   * `This model does not support response format json_schema`, y solo la
   * familia `gpt-oss` lo acepta. En Ollama no lo es —la gramática la impone el
   * servidor—, así que allí esta lista no existe y vale cualquier modelo.
   *
   * Ausente = cualquier modelo. Presente = lo que no esté, falla cerrado. Es
   * deliberado en esa dirección: un modelo desconocido al que se le supone
   * capacidad de exigir citas es exactamente el fallo silencioso que este
   * sistema existe para no tener.
   */
  structuredOutputModels?: string[];
  contextWindow: number;
  maxOutputTokens: number;
  /**
   * Precio de lista del backend, aunque el plan gratuito facture 0.
   *
   * Declarar 0 haría que el arnés informara "coste total $0,0000" y esa cifra
   * no responde a la pregunta que importa: cuánto costaría esta misma tirada en
   * producción. El plan gratuito es una condición de la cuenta, no una
   * propiedad del modelo.
   */
  pricing: { inputPerMillion: number; outputPerMillion: number };
}

/**
 * Los backends conocidos. Añadir uno es una entrada aquí.
 *
 * Los catálogos de modelos de estos proveedores rotan cada pocos meses, así que
 * NO hay lista blanca de modelos como en el adaptador de Claude: allí la lista
 * existe porque `temperature` es una trampa concreta y silenciosa. Aquí la
 * trampa equivalente es la salida estructurada, y se contiene declarándola por
 * backend y dejando que quien necesite citas obligatorias lo compruebe.
 */
/**
 * Qué modo de salida estructurada aplica a este modelo en este backend.
 *
 * Pura y exportada porque es la decisión que separa "puedo exigir citas" de "le
 * pido citas y a ver", y esa distinción no puede depender de que alguien haya
 * leído la documentación del proveedor el día correcto.
 */
export function structuredOutputFor(
  backend: BackendProfile,
  model: string,
): StructuredOutputMode {
  if (backend.structuredOutputModels === undefined) return backend.structuredOutput;
  return backend.structuredOutputModels.includes(model) ? backend.structuredOutput : "none";
}

export const BACKENDS: Record<string, BackendProfile> = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    // NO es `llama-3.3-70b-versatile`, que sería la elección obvia por tamaño:
    // ese modelo rechaza `json_schema` con un 400, así que no puede exigir
    // citas y por tanto no sirve para nada de lo que hace esta plataforma.
    defaultModel: "openai/gpt-oss-120b",
    apiKeyEnv: "GROQ_API_KEY",
    structuredOutput: "json_schema",
    structuredOutputModels: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.75 },
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:7b-instruct",
    // Ollama no autentica. Manda `Authorization` igualmente si se le da clave,
    // porque un vLLM detrás de un proxy sí la pide y es el mismo adaptador.
    apiKeyEnv: undefined,
    structuredOutput: "json_schema",
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    // Local: el coste marginal por token es cero de verdad, no por promoción.
    pricing: { inputPerMillion: 0, outputPerMillion: 0 },
  },
};

export interface OpenAICompatibleOptions {
  /** Identidad del proveedor: `groq`, `ollama`, o el nombre del despliegue. */
  id: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  structuredOutput?: StructuredOutputMode;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  /**
   * Un modelo de 7B en CPU tarda minutos en una respuesta larga. El valor por
   * defecto es generoso a propósito: un timeout corto convierte "lento" en
   * "roto" y el arnés lo contaría como abstención.
   */
  timeoutMs?: number;
  maxRetries?: number;
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: AIProviderCapabilities;
  readonly pricing: { inputPerMillion: number; outputPerMillion: number };

  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #structuredOutput: StructuredOutputMode;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#apiKey = opts.apiKey;
    this.#structuredOutput = opts.structuredOutput ?? "json_schema";
    this.#timeoutMs = opts.timeoutMs ?? 120_000;
    this.#maxRetries = opts.maxRetries ?? 2;

    this.pricing = opts.pricing ?? { inputPerMillion: 0, outputPerMillion: 0 };
    this.capabilities = {
      toolCalling: true,
      // Ver `StructuredOutputMode`: `json_object` no es salida estructurada a
      // efectos de esta bandera, porque no permite exigir nada.
      structuredOutput: this.#structuredOutput === "json_schema",
      // Ninguno de estos backends cachea prefijos de forma explícita: los que
      // lo hacen (Groq) es automático y no se pide ni se factura aparte.
      promptCaching: false,
      contextWindow: opts.contextWindow ?? 32_768,
      maxOutputTokens: opts.maxOutputTokens ?? 8_192,
      // Al contrario que los Claude de última generación, estos modelos sí
      // aceptan `temperature`. Es lo que hace útil el ajuste del tenant.
      sampling: true,
    };
  }

  async generate(req: GenerationRequest): Promise<GenerationResult> {
    if (req.outputSchema !== undefined && this.#structuredOutput !== "json_schema") {
      throw new ProviderError(
        `${this.id}/${this.model} no admite esquemas de salida. Pedir citas ` +
          "obligatorias a un modelo que no las puede exigir produce respuestas " +
          "bien formadas y sin fundar, que es peor que no responder." +
          (this.id === "groq"
            ? " En Groq solo la familia openai/gpt-oss admite json_schema."
            : ""),
        this.id,
        false,
      );
    }

    const startedAt = performance.now();
    const body = buildChatParams(req, this.model, this.capabilities);
    const response = await this.#post(body);

    const choice = response.choices?.[0];
    const text = choice?.message?.content ?? "";
    const usage = {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cachedTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    };

    const stopReason = mapFinishReason(choice?.finish_reason ?? null);

    const result: GenerationResult = {
      text,
      stopReason,
      usage,
      cost:
        (usage.inputTokens / 1_000_000) * this.pricing.inputPerMillion +
        (usage.outputTokens / 1_000_000) * this.pricing.outputPerMillion,
      model: response.model ?? this.model,
      latencyMs: Math.round(performance.now() - startedAt),
    };

    if (req.outputSchema !== undefined && stopReason === "end_turn") {
      try {
        return { ...result, parsed: JSON.parse(text) as unknown };
      } catch {
        // Igual que en el adaptador de Claude: se devuelve sin `parsed` y el
        // validador de §12.2 lo rechaza. Aquí no se inventa nada.
        return result;
      }
    }

    return result;
  }

  /**
   * Envía la petición, reintentando lo que merece reintentarse.
   *
   * Los planes gratuitos devuelven 429 con frecuencia y una tirada del arnés
   * son decenas de llamadas seguidas. Sin esto, la medición fallaría a mitad y
   * el informe diría "abstención" donde hubo un límite de cuota — que es
   * exactamente el tipo de número falso que este arnés existe para no producir.
   */
  async #post(body: Record<string, unknown>): Promise<ChatCompletionResponse> {
    let lastError: ProviderError | undefined;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) {
        // `??` y no `||`: un `Retry-After: 0` es una instrucción —reintenta ya—
        // y tratarlo como ausente añadiría medio segundo a cada reintento por
        // confundir "el servidor dijo cero" con "el servidor no dijo nada".
        const waitMs = lastError?.retryAfterMs ?? 500 * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      try {
        return await this.#postOnce(body);
      } catch (error) {
        if (!(error instanceof ProviderError) || !error.retryable) throw error;
        lastError = error;
      }
    }

    throw lastError ?? new ProviderError("Fallo sin causa", this.id, false);
  }

  async #postOnce(body: Record<string, unknown>): Promise<ChatCompletionResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#apiKey !== undefined) {
      headers["authorization"] = `Bearer ${this.#apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      // Conexión rechazada contra localhost es el caso más frecuente con
      // Ollama, y el mensaje por defecto ("fetch failed") no dice nada.
      throw new ProviderError(
        `No se pudo contactar con ${this.#baseUrl}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        this.id,
        true,
        error,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      throw new ProviderError(
        `${this.id} devolvió ${response.status}: ${detail.slice(0, 500)}`,
        this.id,
        response.status === 408 || response.status === 429 || response.status >= 500,
        undefined,
        retryAfter,
      );
    }

    try {
      return (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      throw new ProviderError(
        `${this.id} devolvió una respuesta que no es JSON`,
        this.id,
        false,
        error,
      );
    }
  }
}

// ===========================================================================
// TRADUCCIÓN DE LA PETICIÓN
// ===========================================================================

/**
 * Traduce una `GenerationRequest` del dominio al cuerpo de chat-completions.
 *
 * Pura y exportada por la misma razón que su gemela en el adaptador de Claude:
 * los invariantes que se comprueban aquí fallan en producción como un 400 o,
 * peor, como una respuesta plausible sin citas.
 */
export function buildChatParams(
  req: GenerationRequest,
  model: string,
  capabilities: AIProviderCapabilities,
): Record<string, unknown> {
  // El `system` es un mensaje más en este protocolo, no un campo aparte.
  const messages: { role: string; content: string }[] = [];
  if (req.system !== undefined) {
    messages.push({ role: "system", content: req.system });
  }
  for (const message of req.messages) {
    messages.push({ role: message.role, content: message.content });
  }

  const params: Record<string, unknown> = {
    model,
    messages,
    max_tokens: Math.min(req.maxTokens, capabilities.maxOutputTokens),
  };

  if (req.outputSchema !== undefined) {
    params["response_format"] = {
      type: "json_schema",
      json_schema: {
        name: "respuesta_fundada",
        // `strict` es lo que convierte el esquema en una obligación del
        // servidor. Sin él, el esquema es una sugerencia y volvemos a
        // "confiar en que el modelo cite".
        strict: true,
        schema: toStrictJsonSchema(req.outputSchema),
      },
    };
  }

  if (req.temperature !== undefined && capabilities.sampling) {
    params["temperature"] = req.temperature;
  }

  // `effort` no tiene traducción en este protocolo. Se descarta en silencio a
  // propósito: es una intención del dominio, y un backend que no la entiende
  // debe ignorarla, no fallar.

  return params;
}

/**
 * Adapta un esquema JSON al modo estricto que exigen estos backends.
 *
 * Dos reglas, y ninguna es opcional para que `strict: true` sea aceptado:
 *
 *  - Todo objeto lleva `additionalProperties: false`.
 *  - **Toda** propiedad aparece en `required`. Lo que era opcional se vuelve
 *    obligatorio-pero-anulable (`type: [..., "null"]`), que es la forma que
 *    tiene este protocolo de expresar opcionalidad.
 *
 * `ANSWER_SCHEMA` declara `rulesApplied` como opcional, así que sin esta
 * traducción el servidor rechaza la petición entera. Mangear el esquema a mano
 * en el sitio de llamada sería peor: habría dos esquemas que mantener
 * sincronizados y el que valida las citas en código es el otro.
 */
export function toStrictJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const node = { ...schema };

  if (node["type"] === "object" && isRecord(node["properties"])) {
    const properties = node["properties"];
    const previouslyRequired = new Set(
      Array.isArray(node["required"]) ? (node["required"] as string[]) : [],
    );

    const rewritten: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (!isRecord(value)) {
        rewritten[key] = value;
        continue;
      }

      const child = toStrictJsonSchema(value);
      rewritten[key] = previouslyRequired.has(key) ? child : nullable(child);
    }

    node["properties"] = rewritten;
    node["required"] = Object.keys(properties);
    node["additionalProperties"] = false;
    return node;
  }

  if (node["type"] === "array" && isRecord(node["items"])) {
    node["items"] = toStrictJsonSchema(node["items"]);
    return node;
  }

  return node;
}

/**
 * Convierte un subesquema en anulable sin perder lo que ya declaraba.
 *
 * Se toca solo `type`: la descripción, el `items` y el resto siguen igual, que
 * es lo que hace que el modelo entienda qué se le pide cuando decide no
 * rellenarlo.
 */
function nullable(schema: Record<string, unknown>): Record<string, unknown> {
  const type = schema["type"];
  if (type === undefined) return schema;
  if (Array.isArray(type)) {
    return type.includes("null") ? schema : { ...schema, type: [...type, "null"] };
  }
  return { ...schema, type: [type, "null"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapFinishReason(reason: string | null): GenerationResult["stopReason"] {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

/** `Retry-After` viene en segundos o como fecha HTTP, según el servidor. */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

interface ChatCompletionResponse {
  model?: string;
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}
