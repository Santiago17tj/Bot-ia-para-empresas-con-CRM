import Anthropic from "@anthropic-ai/sdk";

import {
  ProviderError,
  type AIProvider,
  type AIProviderCapabilities,
  type GenerationRequest,
  type GenerationResult,
} from "../types.js";

/**
 * Implementación de `AIProvider` sobre Claude.
 *
 * Es la ÚNICA parte del repositorio que sabe que Claude existe. Si `Anthropic`
 * aparece importado fuera de este fichero, la costura está rota.
 */

interface ModelProfile {
  capabilities: AIProviderCapabilities;
  pricing: { inputPerMillion: number; outputPerMillion: number };
  /** Los modelos con razonamiento adaptativo aceptan `thinking` + `effort`. */
  adaptiveThinking: boolean;
}

const MODELS: Record<string, ModelProfile> = {
  "claude-opus-5": {
    capabilities: {
      toolCalling: true,
      structuredOutput: true,
      promptCaching: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      // §8.1 — este modelo RECHAZA temperature con un 400.
      sampling: false,
    },
    pricing: { inputPerMillion: 5, outputPerMillion: 25 },
    adaptiveThinking: true,
  },
  "claude-sonnet-5": {
    capabilities: {
      toolCalling: true,
      structuredOutput: true,
      promptCaching: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      sampling: false,
    },
    pricing: { inputPerMillion: 3, outputPerMillion: 15 },
    adaptiveThinking: true,
  },
  "claude-haiku-4-5": {
    capabilities: {
      toolCalling: true,
      structuredOutput: true,
      promptCaching: true,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      sampling: true,
    },
    pricing: { inputPerMillion: 1, outputPerMillion: 5 },
    adaptiveThinking: false,
  },
};

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

/**
 * §8.1 — Por qué `sampling` es una capacidad y no un parámetro que se pasa
 * y ya está.
 *
 * `TenantAIConfig` tiene una columna `temperature` porque un cliente quiere
 * poder ajustarla. Los modelos Claude de última generación la RECHAZAN con un
 * 400 — no la ignoran, fallan. Un adaptador que reenviara ciegamente lo que
 * trae la configuración rompería a todos los tenants el día que se cambia el
 * modelo por defecto, y el error apuntaría a la petición, no a la causa.
 *
 * Esta es exactamente la razón de existir de la capa de proveedores: traducir
 * una intención del dominio ("quiero respuestas más deterministas") a lo que
 * cada API acepta, o descartarla cuando no hay traducción posible.
 */
export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";
  readonly model: string;
  readonly capabilities: AIProviderCapabilities;
  readonly pricing: { inputPerMillion: number; outputPerMillion: number };

  readonly #client: Anthropic;
  readonly #profile: ModelProfile;

  constructor(opts: { apiKey: string; model?: string }) {
    this.model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;

    const profile = MODELS[this.model];
    if (profile === undefined) {
      throw new ProviderError(
        `Modelo Claude desconocido: ${this.model}. Conocidos: ${Object.keys(MODELS).join(", ")}`,
        "anthropic",
        false,
      );
    }

    this.#profile = profile;
    this.capabilities = profile.capabilities;
    this.pricing = profile.pricing;
    this.#client = new Anthropic({ apiKey: opts.apiKey });
  }

  async generate(req: GenerationRequest): Promise<GenerationResult> {
    const startedAt = performance.now();
    const params = buildRequestParams(req, this.model, this.#profile);

    let response: Anthropic.Message;
    try {
      response = await this.#client.messages.create(
        params as unknown as Anthropic.MessageCreateParamsNonStreaming,
      );
    } catch (error) {
      throw new ProviderError(
        `La llamada a Claude falló: ${error instanceof Error ? error.message : String(error)}`,
        this.id,
        isRetryable(error),
        error,
      );
    }

    // El clasificador puede declinar la petición: HTTP 200, `content` vacío o
    // parcial. Leer `content[0]` sin comprobar esto revienta.
    const stopReason = mapStopReason(response.stop_reason);

    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cachedTokens: response.usage.cache_read_input_tokens ?? 0,
    };

    const result: GenerationResult = {
      text,
      stopReason,
      usage,
      cost:
        (usage.inputTokens / 1_000_000) * this.pricing.inputPerMillion +
        (usage.outputTokens / 1_000_000) * this.pricing.outputPerMillion,
      model: response.model,
      latencyMs: Math.round(performance.now() - startedAt),
    };

    if (req.outputSchema !== undefined && stopReason === "end_turn") {
      try {
        return { ...result, parsed: JSON.parse(text) as unknown };
      } catch {
        // Salida estructurada que no parsea: se devuelve sin `parsed` y el
        // validador de §12.2 la rechazará. No se inventa una respuesta aquí.
        return result;
      }
    }

    return result;
  }
}

/**
 * Traduce una `GenerationRequest` del dominio al cuerpo que espera la API.
 *
 * Es una función pura y exportada para que el test pueda comprobar el
 * invariante sin red: que a un modelo que rechaza `temperature` no se le envía
 * `temperature`. Ese fallo, sin test, aparece en producción como un 400 en
 * cada respuesta el día que alguien cambia el modelo por defecto.
 */
export function buildRequestParams(
  req: GenerationRequest,
  model: string,
  profile: ModelProfile,
): Record<string, unknown> {
  // El prefijo estable (instrucciones + ADN + reglas) se marca para caché;
  // lo volátil va después y no se cachea. Ver §23 del plan.
  const system =
    req.system === undefined
      ? undefined
      : req.cacheSystemPrompt === true
        ? [
            {
              type: "text" as const,
              text: req.system,
              cache_control: { type: "ephemeral" as const },
            },
          ]
        : req.system;

  const params: Record<string, unknown> = {
    model,
    max_tokens: Math.min(req.maxTokens, profile.capabilities.maxOutputTokens),
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };

  if (system !== undefined) params["system"] = system;
  if (profile.adaptiveThinking) params["thinking"] = { type: "adaptive" };
  if (req.effort !== undefined) params["output_config"] = { effort: req.effort };

  if (req.outputSchema !== undefined) {
    const existing = (params["output_config"] ?? {}) as Record<string, unknown>;
    params["output_config"] = {
      ...existing,
      format: { type: "json_schema", schema: req.outputSchema },
    };
  }

  // Se descarta a propósito cuando el modelo no la admite: enviarla sería un
  // 400, y el tenant que la configuró no eligió el modelo.
  if (req.temperature !== undefined && profile.capabilities.sampling) {
    params["temperature"] = req.temperature;
  }

  return params;
}

export function modelProfile(model: string): ModelProfile | undefined {
  return MODELS[model];
}

function mapStopReason(reason: string | null): GenerationResult["stopReason"] {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return status === 408 || status === 429 || status >= 500;
  }
  // Fallo de red antes de recibir respuesta: reintentar es correcto.
  return error instanceof Anthropic.APIConnectionError;
}
