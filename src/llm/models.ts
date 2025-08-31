import { logger } from "@/utils/logger";
import type { LLMProvider } from "./types";

// Simple model lists - no need to fetch dynamically
// OpenRouter handles 300+ models, we just need to know the string format

export const KNOWN_MODELS = {
  openai: [
    "gpt-4-turbo",
    "gpt-4",
    "gpt-3.5-turbo",
    "gpt-4o",
    "gpt-4o-mini",
  ],
  anthropic: [
    "claude-3-opus",
    "claude-3-sonnet", 
    "claude-3-haiku",
    "claude-3.5-sonnet",
  ],
  google: [
    "gemini-2.0-flash",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ],
  // OpenRouter handles all these through provider prefixes
  openrouter: [
    "openai/gpt-4",
    "anthropic/claude-3-sonnet",
    "google/gemini-2.0-flash",
    "meta-llama/llama-3.3-70b-instruct",
    // ... 300+ more models
  ]
};

/**
 * Get available models for a provider
 */
export async function getModelsForProvider(
  provider: LLMProvider,
  apiKey?: string,
  ollamaUrl?: string
): Promise<string[] | null> {
  // For OpenRouter, models are specified as provider/model
  if (provider === "openrouter") {
    return KNOWN_MODELS.openrouter;
  }
  
  // Return known models for each provider
  return KNOWN_MODELS[provider as keyof typeof KNOWN_MODELS] || null;
}

/**
 * Get all available models grouped by provider
 */
export async function getAllModels(
  credentials?: Record<string, string>
): Promise<Record<string, string[]>> {
  return KNOWN_MODELS;
}