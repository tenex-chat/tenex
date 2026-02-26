/**
 * models.dev cache for LLM model metadata
 *
 * Fetches model information from https://models.dev/api.json and caches to disk.
 * Uses stale-while-revalidate: serves cached data immediately, refreshes in background if stale.
 */

import * as path from "node:path";
import { ensureDirectory, fileExists, readJsonFile, writeJsonFile, getFileStats } from "@/lib/fs";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const CACHE_FILE_NAME = "models-dev.json";
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Model limits from models.dev
 */
export interface ModelLimits {
    /** Context window size in tokens */
    context: number;
    /** Max output tokens */
    output: number;
}

/**
 * models.dev API response structure
 */
interface ModelsDevResponse {
    [provider: string]: {
        models: {
            [modelId: string]: {
                limit?: {
                    context?: number;
                    output?: number;
                };
            };
        };
    };
}

/**
 * Cached data structure
 */
interface CacheData {
    fetchedAt: number;
    data: ModelsDevResponse;
}

// In-memory cache (loaded from disk)
let cache: ModelsDevResponse | null = null;
let cacheLoadPromise: Promise<void> | null = null;

/**
 * Provider ID mapping from our providers to models.dev providers
 */
const PROVIDER_MAPPING: Record<string, string | null> = {
    anthropic: "anthropic",
    openai: "openai",
    openrouter: "openrouter",
    // These providers are not in models.dev (local/custom)
    ollama: null,
    "claude-code": null,
    "codex-app-server": null,
};

/**
 * Get the cache file path
 */
function getCacheFilePath(): string {
    return path.join(config.getConfigPath("cache"), CACHE_FILE_NAME);
}

/**
 * Fetch data from models.dev API
 */
async function fetchFromApi(): Promise<ModelsDevResponse | null> {
    try {
        const response = await fetch(MODELS_DEV_API_URL);
        if (!response.ok) {
            logger.warn("Failed to fetch models.dev API", {
                status: response.status,
                statusText: response.statusText,
            });
            return null;
        }
        return (await response.json()) as ModelsDevResponse;
    } catch (error) {
        logger.warn("Error fetching models.dev API", { error });
        return null;
    }
}

/**
 * Load cache from disk
 */
async function loadFromDisk(): Promise<CacheData | null> {
    const cacheFile = getCacheFilePath();
    if (!(await fileExists(cacheFile))) {
        return null;
    }
    return readJsonFile<CacheData>(cacheFile);
}

/**
 * Save cache to disk
 */
async function saveToDisk(data: ModelsDevResponse): Promise<void> {
    const cacheFile = getCacheFilePath();
    await ensureDirectory(path.dirname(cacheFile));
    const cacheData: CacheData = {
        fetchedAt: Date.now(),
        data,
    };
    await writeJsonFile(cacheFile, cacheData);
}

/**
 * Check if cache is stale (older than 24 hours)
 */
async function isCacheStale(): Promise<boolean> {
    const cacheFile = getCacheFilePath();
    const stats = await getFileStats(cacheFile);
    if (!stats) return true;

    const age = Date.now() - stats.mtimeMs;
    return age > STALE_THRESHOLD_MS;
}

/**
 * Refresh cache from API (runs in background)
 */
async function refreshInBackground(): Promise<void> {
    const freshData = await fetchFromApi();
    if (freshData) {
        cache = freshData;
        await saveToDisk(freshData);
        logger.debug("models.dev cache refreshed");
    }
}

/**
 * Ensure cache is loaded (call at startup)
 * Blocks until cache is ready. Fetches from API if no cached data exists.
 */
export async function ensureCacheLoaded(): Promise<void> {
    // If already loading, wait for that
    if (cacheLoadPromise) {
        await cacheLoadPromise;
        return;
    }

    // If already loaded, check for background refresh
    if (cache) {
        if (await isCacheStale()) {
            // Trigger background refresh, don't wait
            refreshInBackground().catch((err) =>
                logger.warn("Background cache refresh failed", { error: err })
            );
        }
        return;
    }

    // Start loading
    cacheLoadPromise = (async () => {
        // Try to load from disk first
        const diskCache = await loadFromDisk();
        if (diskCache?.data) {
            cache = diskCache.data;
            logger.debug("models.dev cache loaded from disk");

            // Check if stale and trigger background refresh
            if (await isCacheStale()) {
                refreshInBackground().catch((err) =>
                    logger.warn("Background cache refresh failed", { error: err })
                );
            }
            return;
        }

        // No cache on disk, fetch from API
        logger.debug("models.dev cache not found, fetching from API");
        const freshData = await fetchFromApi();
        if (freshData) {
            cache = freshData;
            await saveToDisk(freshData);
            logger.debug("models.dev cache fetched and saved");
        } else {
            logger.warn("Could not load models.dev data - model limits will be unavailable");
        }
    })();

    try {
        await cacheLoadPromise;
    } finally {
        cacheLoadPromise = null;
    }
}

/**
 * Force refresh cache from API
 */
export async function refreshCache(): Promise<void> {
    const freshData = await fetchFromApi();
    if (freshData) {
        cache = freshData;
        await saveToDisk(freshData);
        logger.info("models.dev cache force refreshed");
    } else {
        throw new Error("Failed to refresh models.dev cache");
    }
}

/**
 * Get model limits for a specific provider and model
 *
 * @param provider Our provider ID (e.g., "anthropic", "openai", "openrouter")
 * @param model Model ID (e.g., "claude-opus-4-5-20251101", "gpt-4o")
 * @returns Model limits or undefined if not found/unsupported
 */
export function getModelLimits(provider: string, model: string): ModelLimits | undefined {
    if (!cache) {
        return undefined;
    }

    // Map our provider ID to models.dev provider ID
    const modelsDevProvider = PROVIDER_MAPPING[provider];
    if (modelsDevProvider === null || modelsDevProvider === undefined) {
        // Provider not supported by models.dev
        return undefined;
    }

    const providerData = cache[modelsDevProvider];
    if (!providerData?.models) {
        return undefined;
    }

    const modelData = providerData.models[model];
    if (!modelData?.limit) {
        return undefined;
    }

    const { context, output } = modelData.limit;
    if (context === undefined || output === undefined) {
        return undefined;
    }

    return { context, output };
}

/**
 * Get just the context window for a model
 * Convenience function for backwards compatibility with context-window-cache
 */
export function getContextWindowFromModelsdev(provider: string, model: string): number | undefined {
    const limits = getModelLimits(provider, model);
    return limits?.context;
}

/**
 * Clear in-memory cache (for testing)
 */
export function clearModelsDevCache(): void {
    cache = null;
    cacheLoadPromise = null;
}
