/**
 * Context window cache for LLM models
 * Provides both hardcoded fallbacks and dynamic fetching
 */

const cache = new Map<string, number>();

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
