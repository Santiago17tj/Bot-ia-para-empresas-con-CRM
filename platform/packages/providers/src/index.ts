export type {
  AIProvider,
  AIProviderCapabilities,
  EmbeddingKind,
  EmbeddingProvider,
  GenerationMessage,
  GenerationRequest,
  GenerationResult,
} from "./types.js";
export { ProviderError } from "./types.js";

export { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./ai/anthropic.js";
export { OpenAIEmbeddingProvider } from "./embedding/openai.js";
export { DeterministicEmbeddingProvider } from "./embedding/deterministic.js";

export {
  createAIProvider,
  createEmbeddingProvider,
  providerStatus,
} from "./registry.js";
export type {
  AIProviderId,
  AIProviderOptions,
  EmbeddingProviderId,
  EmbeddingProviderOptions,
} from "./registry.js";
