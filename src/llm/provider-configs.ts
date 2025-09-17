import type { AISdkProvider, ProviderConfig } from "./types";

/**
 * Provider-specific configurations
 * Defines which providers support true streaming vs non-streaming
 * 
 * Non-streaming providers (like claudeCode) send their entire response in a single chunk.
 * The LLMService will automatically simulate streaming for these providers to maintain
 * a consistent interface for all consumers.
 */
export const PROVIDER_CONFIGS: Record<AISdkProvider, ProviderConfig> = {
  openrouter: {
    provider: "openrouter",
    streaming: true,  // OpenRouter supports streaming
  },
  anthropic: {
    provider: "anthropic",
    streaming: true,  // Anthropic supports streaming
  },
  openai: {
    provider: "openai",
    streaming: true,  // OpenAI supports streaming
  },
  ollama: {
    provider: "ollama",
    streaming: true,  // Ollama supports streaming
  },
  claudeCode: {
    provider: "claudeCode",
    streaming: false, // Claude Code doesn't support true streaming - sends complete response
  },
};

/**
 * Check if a provider supports streaming
 */
export function providerSupportsStreaming(provider: AISdkProvider): boolean {
  return PROVIDER_CONFIGS[provider]?.streaming ?? true;
}