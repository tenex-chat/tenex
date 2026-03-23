import type {
    ContextBudgetProfile,
    PromptTokenEstimator,
} from "ai-sdk-context-management";
import type { LanguageModelV3CallOptions, LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { isFullEventId, shortenEventId } from "@/types/event-ids";

export const MANAGED_CONTEXT_BUDGET_SCOPE = "managed-context";
const MANAGED_CONTEXT_LABEL = "managed working budget";
const MANAGED_CONTEXT_DESCRIPTION =
    "This excludes base system prompts, tool definitions, and reminder blocks.";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isManagedContextSystemMessage(message: LanguageModelV3Message): boolean {
    if (message.role !== "system") {
        return false;
    }

    const contextManagementOptions = message.providerOptions?.contextManagement;
    if (!isRecord(contextManagementOptions)) {
        return false;
    }

    const type = contextManagementOptions.type;
    return type === "summary" || type === "compaction-summary";
}

export function createManagedContextTokenEstimator(
    baseEstimator: PromptTokenEstimator
): PromptTokenEstimator {
    return {
        estimateMessage(message: LanguageModelV3Message): number {
            if (message.role === "system" && !isManagedContextSystemMessage(message)) {
                return 0;
            }

            return baseEstimator.estimateMessage(message);
        },
        estimatePrompt(prompt: LanguageModelV3Prompt): number {
            return prompt.reduce((sum, message) => sum + this.estimateMessage(message), 0);
        },
        estimateTools(): number {
            return 0;
        },
    };
}

export function createManagedContextBudgetProfile(
    tokenBudget: number,
    requestEstimator: PromptTokenEstimator
): ContextBudgetProfile {
    return {
        tokenBudget,
        estimator: createManagedContextTokenEstimator(requestEstimator),
        label: MANAGED_CONTEXT_LABEL,
        description: MANAGED_CONTEXT_DESCRIPTION,
    };
}

export function normalizeProviderId(providerId: string): string {
    return providerId.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

export function buildDecayPlaceholder(
    toolName: string,
    toolCallId: string,
    toolCallEventIdMap: Map<string, string>,
): string {
    const eventId = toolCallEventIdMap.get(toolCallId);
    const rawId = eventId ?? toolCallId;
    const id = isFullEventId(rawId) ? shortenEventId(rawId) : rawId;
    return `[${toolName} was used, id: ${id} -- use fs_read(tool: "${id}") to retrieve]`;
}

export function estimateRequestTokens(
    estimator: PromptTokenEstimator,
    prompt: LanguageModelV3Prompt,
    tools: LanguageModelV3CallOptions["tools"]
): number {
    return estimator.estimatePrompt(prompt) + (estimator.estimateTools?.(tools) ?? 0);
}
