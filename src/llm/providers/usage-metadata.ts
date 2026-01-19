/**
 * Usage metadata extraction dispatcher
 *
 * Routes usage metadata extraction to the appropriate provider-specific extractor.
 */

import type { LanguageModelUsage } from "ai";
import type { LanguageModelUsageWithCostUsd } from "../types";
import { PROVIDER_IDS } from "./provider-ids";
import { OpenRouterProvider } from "./standard/OpenRouterProvider";
import { ClaudeCodeProvider } from "./agent/ClaudeCodeProvider";
import { CodexAppServerProvider } from "./agent/CodexAppServerProvider";

/**
 * AI SDK usage with optional extended fields (for standard providers)
 */
interface ExtendedUsage extends LanguageModelUsage {
    cachedInputTokens?: number;
    reasoningTokens?: number;
}

/**
 * Extract usage metadata from standard providers that report directly in totalUsage
 */
function extractStandardUsage(
    model: string,
    totalUsage: LanguageModelUsage | undefined
): LanguageModelUsageWithCostUsd {
    const extendedUsage = totalUsage as ExtendedUsage | undefined;

    const inputTokens = totalUsage?.inputTokens;
    const outputTokens = totalUsage?.outputTokens;
    const totalTokens = totalUsage?.totalTokens ??
        (inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined);

    return {
        model,
        inputTokens,
        outputTokens,
        totalTokens,
        cachedInputTokens: extendedUsage?.cachedInputTokens,
        reasoningTokens: extendedUsage?.reasoningTokens,
    } as LanguageModelUsageWithCostUsd;
}

/**
 * Extract usage metadata from provider response
 *
 * Dispatches to the appropriate provider-specific extractor based on provider ID.
 */
export function extractUsageMetadata(
    provider: string,
    model: string,
    totalUsage: LanguageModelUsage | undefined,
    providerMetadata: Record<string, unknown> | undefined
): LanguageModelUsageWithCostUsd {
    switch (provider) {
        case PROVIDER_IDS.OPENROUTER:
            return OpenRouterProvider.extractUsageMetadata(model, totalUsage, providerMetadata);
        case PROVIDER_IDS.CLAUDE_CODE:
            return ClaudeCodeProvider.extractUsageMetadata(model, totalUsage, providerMetadata);
        case PROVIDER_IDS.CODEX_APP_SERVER:
            return CodexAppServerProvider.extractUsageMetadata(model, totalUsage, providerMetadata);
        default:
            return extractStandardUsage(model, totalUsage);
    }
}

/**
 * Extract OpenRouter generation ID for trace correlation
 */
export function extractOpenRouterGenerationId(
    providerMetadata: Record<string, unknown> | undefined
): string | undefined {
    return OpenRouterProvider.extractGenerationId(providerMetadata);
}
