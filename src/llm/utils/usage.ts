import type { LanguageModelUsage } from "ai";
import type { LanguageModelUsageWithCostUsd } from "../types";

interface OpenRouterUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cost?: number;
    promptTokensDetails?: {
        cachedTokens?: number;
    };
    completionTokensDetails?: {
        reasoningTokens?: number;
    };
}

interface StepProviderMetadata {
    openrouter?: {
        usage?: OpenRouterUsage;
    };
    [key: string]: unknown;
}

type StepUsage = Partial<Pick<LanguageModelUsage, "inputTokens" | "outputTokens">>;

export interface StepWithProviderMetadata {
    usage?: StepUsage;
    providerMetadata?: StepProviderMetadata;
}

/**
 * Extract usage from the most recent completed LLM step.
 * Returns undefined if no steps provided.
 * Extracts token counts, cost, and detailed token breakdowns from OpenRouter providerMetadata.
 */
export function extractLastStepUsage(
    steps: StepWithProviderMetadata[]
): LanguageModelUsageWithCostUsd | undefined {
    if (steps.length === 0) {
        return undefined;
    }

    const step = steps[steps.length - 1];
    const openrouterUsage = step.providerMetadata?.openrouter?.usage;

    const inputTokens = openrouterUsage?.promptTokens ?? step.usage?.inputTokens ?? 0;
    const outputTokens = openrouterUsage?.completionTokens ?? step.usage?.outputTokens ?? 0;
    const costUsd = openrouterUsage?.cost ?? 0;
    const cachedInputTokens = openrouterUsage?.promptTokensDetails?.cachedTokens ?? 0;
    const reasoningTokens = openrouterUsage?.completionTokensDetails?.reasoningTokens ?? 0;

    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costUsd: costUsd > 0 ? costUsd : undefined,
        cachedInputTokens: cachedInputTokens > 0 ? cachedInputTokens : undefined,
        reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    } as LanguageModelUsageWithCostUsd;
}
