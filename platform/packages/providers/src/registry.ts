import { optional, required } from "@platform/env";

import { AnthropicProvider } from "./ai/anthropic.js";
import { DeterministicEmbeddingProvider } from "./embedding/deterministic.js";
import { OpenAIEmbeddingProvider } from "./embedding/openai.js";
import { ProviderError, type AIProvider, type EmbeddingProvider } from "./types.js";

/**
 * Resuelve el proveedor a partir de configuración.
 *
 * Añadir uno nuevo es un fichero en `ai/` o `embedding/` y una entrada en el
 * `switch`. Nada más del sistema cambia — que es exactamente lo que la costura
 * tenía que comprar.
 */

export type AIProviderId = "anthropic";
export type EmbeddingProviderId = "openai" | "deterministic";

export interface AIProviderOptions {
  provider?: string;
  model?: string;
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
    default:
      throw new ProviderError(
        `Proveedor de IA no soportado: ${id}. Implementado: anthropic.`,
        id,
        false,
      );
  }
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
    case "deterministic": {
      const options: { dimensions?: number } = {};
      if (dimensions !== undefined) options.dimensions = dimensions;
      return new DeterministicEmbeddingProvider(options);
    }
    default:
      throw new ProviderError(
        `Proveedor de embeddings no soportado: ${id}. Implementado: openai, deterministic.`,
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
  return [
    {
      label: `IA (${optional("AI_PROVIDER") ?? "anthropic"})`,
      ready: optional("ANTHROPIC_API_KEY") !== undefined,
    },
    {
      label: `Embeddings (${optional("EMBEDDING_PROVIDER") ?? "openai"})`,
      ready:
        optional("EMBEDDING_PROVIDER") === "deterministic" ||
        optional("OPENAI_API_KEY") !== undefined,
    },
  ];
}
