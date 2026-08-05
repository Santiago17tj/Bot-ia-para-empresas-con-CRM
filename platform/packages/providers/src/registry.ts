import { optional, required } from "@platform/env";

import { AnthropicProvider } from "./ai/anthropic.js";
import {
  BACKENDS,
  OpenAICompatibleProvider,
  structuredOutputFor,
} from "./ai/openai-compatible.js";
import { DeterministicEmbeddingProvider } from "./embedding/deterministic.js";
import { LocalEmbeddingProvider } from "./embedding/local.js";
import { OpenAIEmbeddingProvider } from "./embedding/openai.js";
import { ProviderError, type AIProvider, type EmbeddingProvider } from "./types.js";

/**
 * Resuelve el proveedor a partir de configuración.
 *
 * Añadir uno nuevo es un fichero en `ai/` o `embedding/` y una entrada en el
 * `switch`. Nada más del sistema cambia — que es exactamente lo que la costura
 * tenía que comprar.
 */

export type AIProviderId = "anthropic" | "groq" | "ollama";
export type EmbeddingProviderId = "openai" | "local" | "deterministic";

export interface AIProviderOptions {
  provider?: string;
  model?: string;
  /** Anula la URL base del backend. Es lo que hace servible un vLLM propio. */
  baseUrl?: string;
}

export function createAIProvider(opts: AIProviderOptions = {}): AIProvider {
  const id = opts.provider ?? optional("AI_PROVIDER") ?? "anthropic";

  switch (id) {
    case "anthropic": {
      const options: { apiKey: string; model?: string } = {
        apiKey: required("ANTHROPIC_API_KEY"),
      };
      const model = opts.model ?? optional("AI_MODEL");
      if (model !== undefined) options.model = model;
      return new AnthropicProvider(options);
    }

    // Mismo adaptador, distinta URL base. Que estos dos casos sean idénticos
    // salvo el nombre del backend ES el argumento: Groq y Ollama no eran dos
    // decisiones de arquitectura, eran dos valores de configuración.
    case "groq":
    case "ollama":
      return createOpenAICompatible(id, opts);

    default:
      throw new ProviderError(
        `Proveedor de IA no soportado: ${id}. Implementado: anthropic, groq, ollama.`,
        id,
        false,
      );
  }
}

/**
 * Construye un proveedor sobre un backend compatible con OpenAI.
 *
 * La clave se exige solo si el backend la declara: Ollama no autentica, y
 * pedirle una `OLLAMA_API_KEY` inexistente rompería el único camino que
 * funciona sin registrarse en ningún sitio.
 */
function createOpenAICompatible(id: string, opts: AIProviderOptions): AIProvider {
  const backend = BACKENDS[id];
  if (backend === undefined) {
    throw new ProviderError(`Backend desconocido: ${id}`, id, false);
  }

  const model = opts.model ?? optional("AI_MODEL") ?? backend.defaultModel;

  const options: {
    id: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    structuredOutput: typeof backend.structuredOutput;
    contextWindow: number;
    maxOutputTokens: number;
    pricing: typeof backend.pricing;
    timeoutMs?: number;
  } = {
    id,
    baseUrl: opts.baseUrl ?? optional("AI_BASE_URL") ?? backend.baseUrl,
    model,
    // En algunos backends la salida estructurada es del modelo, no del
    // servidor. Un modelo fuera de la lista se queda sin ella, y quien pida
    // citas obligatorias fallará al entrar en vez de recibir un 400 por cada
    // respuesta.
    structuredOutput: structuredOutputFor(backend, model),
    contextWindow: backend.contextWindow,
    maxOutputTokens: backend.maxOutputTokens,
    pricing: backend.pricing,
  };

  if (backend.apiKeyEnv !== undefined) {
    options.apiKey = required(backend.apiKeyEnv);
  }

  const timeout = optional("AI_TIMEOUT_MS");
  if (timeout !== undefined) options.timeoutMs = Number(timeout);

  return new OpenAICompatibleProvider(options);
}

export interface EmbeddingProviderOptions {
  provider?: string;
  model?: string;
  dimensions?: number;
}

export function createEmbeddingProvider(
  opts: EmbeddingProviderOptions = {},
): EmbeddingProvider {
  const id = opts.provider ?? optional("EMBEDDING_PROVIDER") ?? "openai";

  const model = opts.model ?? optional("EMBEDDING_MODEL");
  const dimensionsRaw = optional("EMBEDDING_DIMENSIONS");
  const dimensions =
    opts.dimensions ?? (dimensionsRaw === undefined ? undefined : Number(dimensionsRaw));

  switch (id) {
    case "openai": {
      const options: {
        apiKey: string;
        model?: string;
        dimensions?: number;
      } = { apiKey: required("OPENAI_API_KEY") };
      if (model !== undefined) options.model = model;
      if (dimensions !== undefined) options.dimensions = dimensions;
      return new OpenAIEmbeddingProvider(options);
    }
    case "local": {
      const options: { model?: string; dimensions?: number } = {};
      if (model !== undefined) options.model = model;
      if (dimensions !== undefined) options.dimensions = dimensions;
      return new LocalEmbeddingProvider(options);
    }
    case "deterministic": {
      const options: { dimensions?: number } = {};
      if (dimensions !== undefined) options.dimensions = dimensions;
      return new DeterministicEmbeddingProvider(options);
    }
    default:
      throw new ProviderError(
        `Proveedor de embeddings no soportado: ${id}. Implementado: openai, local, deterministic.`,
        id,
        false,
      );
  }
}

/**
 * Qué está configurado en esta instalación, para imprimirlo al arrancar.
 *
 * Una credencial ausente quita una capacidad, nunca lanza — y el sistema lo
 * dice en voz alta en vez de descubrirlo en la primera llamada fallida.
 */
export function providerStatus(): { label: string; ready: boolean }[] {
  const aiId = optional("AI_PROVIDER") ?? "anthropic";
  const backend = BACKENDS[aiId];

  return [
    {
      label: `IA (${aiId})`,
      // Un backend sin `apiKeyEnv` está listo sin credencial ninguna: es
      // exactamente lo que Ollama compra. Exigirle una clave lo marcaría como
      // no configurado justo cuando es el único que funciona sin cuenta.
      ready:
        backend !== undefined
          ? backend.apiKeyEnv === undefined ||
            optional(backend.apiKeyEnv) !== undefined
          : optional("ANTHROPIC_API_KEY") !== undefined,
    },
    {
      label: `Embeddings (${optional("EMBEDDING_PROVIDER") ?? "openai"})`,
      ready:
        ["deterministic", "local"].includes(optional("EMBEDDING_PROVIDER") ?? "") ||
        optional("OPENAI_API_KEY") !== undefined,
    },
  ];
}
