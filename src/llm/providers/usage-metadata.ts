/**
 * Usage and metadata extraction dispatcher
 *
 * Routes provider-specific usage and metadata extraction based on provider ID.
 */

import type { LanguageModelUsage } from "ai";
import type { LLMMetadata, LanguageModelUsageWithCostUsd } from "../types";
import { PROVIDER_IDS } from "./provider-ids";
import { OpenRouterProvider } from "./standard/OpenRouterProvider";
import { CodexProvider } from "./agent/CodexProvider";

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
        inputTokenDetails: totalUsage?.inputTokenDetails,
        outputTokenDetails: totalUsage?.outputTokenDetails,
        cachedInputTokens: extendedUsage?.cachedInputTokens,
        reasoningTokens: extendedUsage?.reasoningTokens,
    } as LanguageModelUsageWithCostUsd;
}

function extractAnthropicMetadata(
    providerMetadata: Record<string, unknown> | undefined
): LLMMetadata | undefined {
    const anthropicMetadata = providerMetadata?.anthropic as
        | {
            contextManagement?: {
                appliedEdits?: Array<{
                    type?: string;
                    clearedInputTokens?: number;
                    clearedToolUses?: number;
                    clearedThinkingTurns?: number;
                }>;
            };
        }
        | undefined;

    const appliedEdits = Array.isArray(anthropicMetadata?.contextManagement?.appliedEdits)
        ? anthropicMetadata.contextManagement.appliedEdits
        : [];
    if (appliedEdits.length === 0) {
        return undefined;
    }

    return {
        providerContextEditCount: appliedEdits.length,
        providerContextClearedInputTokens: appliedEdits.reduce(
            (total, edit) => total + (typeof edit.clearedInputTokens === "number" ? edit.clearedInputTokens : 0),
            0
        ),
        providerContextClearedToolUses: appliedEdits.reduce(
            (total, edit) => total + (typeof edit.clearedToolUses === "number" ? edit.clearedToolUses : 0),
            0
        ),
        providerContextClearedThinkingTurns: appliedEdits.reduce(
            (total, edit) => total + (typeof edit.clearedThinkingTurns === "number" ? edit.clearedThinkingTurns : 0),
            0
        ),
        providerContextEditsJson: JSON.stringify(appliedEdits),
    };
}

function mergeMetadata(
    ...items: Array<LLMMetadata | undefined>
): LLMMetadata | undefined {
    const merged = Object.assign({}, ...items.filter((item) => item !== undefined));
    return Object.keys(merged).length > 0 ? merged : undefined;
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
        case PROVIDER_IDS.CODEX:
            return CodexProvider.extractUsageMetadata(model, totalUsage, providerMetadata);
        default:
            return extractStandardUsage(model, totalUsage);
    }
}

export function extractLLMMetadata(
    provider: string,
    providerMetadata: Record<string, unknown> | undefined
): LLMMetadata | undefined {
    switch (provider) {
        case PROVIDER_IDS.CODEX:
            return mergeMetadata(
                CodexProvider.extractMetadata(providerMetadata),
                extractAnthropicMetadata(providerMetadata)
            );
        case PROVIDER_IDS.ANTHROPIC:
            return extractAnthropicMetadata(providerMetadata);
        default:
            return extractAnthropicMetadata(providerMetadata);
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
