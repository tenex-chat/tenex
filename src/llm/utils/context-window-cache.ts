/**
 * Context window cache for LLM models
 * Provides both hardcoded fallbacks and dynamic fetching
 */

import { fetchOpenRouterModels } from "@/llm/providers/openrouter-models";

const cache = new Map<string, number>();

/** Track in-flight fetches to avoid duplicate requests */
const pendingFetches = new Map<string, Promise<void>>();

/**
 * Hardcoded context windows for providers without metadata APIs
 */
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
    // Anthropic - all 200K (1M beta requires special header)
    "anthropic:claude-sonnet-4-20250514": 200_000,
    "anthropic:claude-opus-4-20250514": 200_000,
    "anthropic:claude-3-5-sonnet-20241022": 200_000,
    "anthropic:claude-3-5-haiku-20241022": 200_000,
    "anthropic:claude-3-opus-20240229": 200_000,
    "anthropic:claude-3-sonnet-20240229": 200_000,
    "anthropic:claude-3-haiku-20240307": 200_000,

    // OpenAI
    "openai:gpt-4o": 128_000,
    "openai:gpt-4o-mini": 128_000,
    "openai:gpt-4-turbo": 128_000,
    "openai:gpt-4": 8_192,
    "openai:gpt-3.5-turbo": 16_385,
    "openai:o1": 200_000,
    "openai:o1-mini": 128_000,
    "openai:o1-preview": 128_000,
    "openai:o3-mini": 200_000,
};

/**
 * Get cached context window for a model
 * Returns undefined if not cached or unknown
 */
export function getContextWindow(provider: string, model: string): number | undefined {
    const key = `${provider}:${model}`;

    // Check runtime cache first
    if (cache.has(key)) {
        return cache.get(key);
    }

    // Check hardcoded fallbacks
    if (KNOWN_CONTEXT_WINDOWS[key]) {
        return KNOWN_CONTEXT_WINDOWS[key];
    }

    return undefined;
}

/**
 * Clear the cache (for testing)
 */
export function clearCache(): void {
    cache.clear();
}

/**
 * Resolve context window for a model (async)
 * For OpenRouter, fetches and caches all models at once
 */
export async function resolveContextWindow(provider: string, model: string): Promise<void> {
    const key = `${provider}:${model}`;

    // Already cached
    if (cache.has(key) || KNOWN_CONTEXT_WINDOWS[key]) {
        return;
    }

    // Check if fetch already in progress
    if (pendingFetches.has(provider)) {
        await pendingFetches.get(provider);
        return;
    }

    switch (provider) {
        case "openrouter":
            await fetchAndCacheOpenRouter();
            break;
    }
}

async function fetchAndCacheOpenRouter(): Promise<void> {
    const fetchPromise = (async () => {
        const models = await fetchOpenRouterModels();
        for (const model of models) {
            cache.set(`openrouter:${model.id}`, model.context_length);
        }
    })();

    pendingFetches.set("openrouter", fetchPromise);

    try {
        await fetchPromise;
    } finally {
        pendingFetches.delete("openrouter");
    }
}
