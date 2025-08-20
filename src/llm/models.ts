import { loadModels, loadOpenRouterModels, type ModelsList } from "multi-llm-ts";
import { logger } from "@/utils/logger";
import type { LLMProvider } from "./types";

/**
 * Get available models for a provider
 */
export async function getModelsForProvider(
  provider: LLMProvider,
  apiKey?: string
): Promise<ModelsList | null> {
  try {
    if (provider === "openrouter" && apiKey) {
      return await loadOpenRouterModels({ apiKey });
    }

    const providerMap: Record<string, string> = {
      mistral: "mistralai",
      groq: "groq",
      deepseek: "deepseek",
      anthropic: "anthropic",
      openai: "openai",
      google: "google",
      ollama: "ollama",
    };

    const mappedProvider = providerMap[provider] || provider;
    return await loadModels(mappedProvider, {});
  } catch (error) {
    logger.error(`Failed to load models for provider ${provider}:`, error);
    return null;
  }
}

/**
 * Get all available models grouped by provider
 */
export async function getAllModels(
  credentials?: Record<string, string>
): Promise<Record<string, ModelsList>> {
  const providers: LLMProvider[] = [
    "openai",
    "anthropic",
    "google",
    "groq",
    "deepseek",
    "ollama",
    "mistral",
  ];

  const results: Record<string, ModelsList> = {};

  await Promise.all(
    providers.map(async (provider) => {
      const models = await getModelsForProvider(provider, credentials?.[provider]);
      if (models) {
        results[provider] = models;
      }
    })
  );

  // Handle OpenRouter separately if credentials are provided
  if (credentials?.openrouter) {
    const openRouterModels = await getModelsForProvider("openrouter", credentials.openrouter);
    if (openRouterModels) {
      results.openrouter = openRouterModels;
    }
  }

  return results;
}
