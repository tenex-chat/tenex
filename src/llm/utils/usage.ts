import type { LanguageModelUsageWithCostUsd } from "../types";

/**
 * Calculate cumulative usage from an array of steps.
 * Returns undefined if no steps provided.
 */
export function calculateCumulativeUsage(
    steps: Array<{ usage?: { inputTokens?: number; outputTokens?: number } }>
): LanguageModelUsageWithCostUsd | undefined {
    if (steps.length === 0) {
        return undefined;
    }

    const inputTokens = steps.reduce((sum, s) => sum + (s.usage?.inputTokens ?? 0), 0);
    const outputTokens = steps.reduce((sum, s) => sum + (s.usage?.outputTokens ?? 0), 0);

    return {
        inputTokens,
        outputTokens,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    } as LanguageModelUsageWithCostUsd;
}
