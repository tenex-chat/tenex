/**
 * Context window cache for LLM models
 * Delegates to models-dev-cache for model metadata
 */

import { getContextWindowFromModelsdev, clearModelsDevCache } from "./models-dev-cache";

/**
 * Get context window for a model
 * Returns undefined if not found
 */
export function getContextWindow(provider: string, model: string): number | undefined {
    return getContextWindowFromModelsdev(provider, model);
}

/**
 * Resolve context window for a model (async)
 * No-op since models-dev-cache handles loading
 */
export async function resolveContextWindow(_provider: string, _model: string): Promise<void> {
    // models-dev-cache loads data at startup via ensureCacheLoaded()
    // Nothing to do here
}

/**
 * Clear the cache (for testing)
 */
export function clearCache(): void {
    clearModelsDevCache();
}
