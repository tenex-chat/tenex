import type { LanguageModelUsageWithCostUsd } from "@/llm/types";

interface CacheAwareUsage {
    cachedInputTokens?: number;
    inputTokenDetails?: {
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
    };
}

function getPositiveNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function getCachedInputTokensFromProviderMetadata(providerMetadata: unknown): number {
    if (!providerMetadata || typeof providerMetadata !== "object") {
        return 0;
    }

    const openrouter = (providerMetadata as {
        openrouter?: {
            usage?: {
                promptTokensDetails?: {
                    cachedTokens?: number;
                };
            };
        };
    }).openrouter;

    return getPositiveNumber(openrouter?.usage?.promptTokensDetails?.cachedTokens);
}

export function didEstablishPromptCacheFromUsage(
    usage: unknown
): boolean {
    if (!usage || typeof usage !== "object") {
        return false;
    }

    const cacheAwareUsage = usage as CacheAwareUsage | LanguageModelUsageWithCostUsd;

    return getPositiveNumber(cacheAwareUsage.cachedInputTokens) > 0
        || getPositiveNumber(cacheAwareUsage.inputTokenDetails?.cacheReadTokens) > 0;
}

export function didEstablishPromptCache(params: {
    usage: unknown;
    providerMetadata?: unknown;
}): boolean {
    return didEstablishPromptCacheFromUsage(params.usage)
        || getCachedInputTokensFromProviderMetadata(params.providerMetadata) > 0;
}
