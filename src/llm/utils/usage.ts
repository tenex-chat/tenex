import type { LanguageModelUsage } from "ai";
import type { LanguageModelUsageWithCostUsd } from "../types";

interface OpenRouterUsage {
    promptTokens?: number;
    completionTokens?: number;
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
 * Calculate cumulative usage from an array of steps.
 * Returns undefined if no steps provided.
 */
export function calculateCumulativeUsage(
    steps: StepWithProviderMetadata[]
): LanguageModelUsageWithCostUsd | undefined {
    if (steps.length === 0) {
        return undefined;
    }

    const inputTokens = steps.reduce((sum, step) => {
        const openrouterUsage = step.providerMetadata?.openrouter?.usage;
        return sum + (openrouterUsage?.promptTokens ?? step.usage?.inputTokens ?? 0);
    }, 0);
    const outputTokens = steps.reduce((sum, step) => {
        const openrouterUsage = step.providerMetadata?.openrouter?.usage;
        return sum + (openrouterUsage?.completionTokens ?? step.usage?.outputTokens ?? 0);
    }, 0);

    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    } as LanguageModelUsageWithCostUsd;
}
