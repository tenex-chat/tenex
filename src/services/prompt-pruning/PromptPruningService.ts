import { defaultToolPolicy, prunePrompt } from "ai-sdk-context-management";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { PromptMessage } from "@/conversations/PromptBuilder";
import { beforeToolCompression } from "./before-tool-compression";

export interface PromptPruningConfig {
    messages: PromptMessage[];
    maxTokens: number;
    preservedTailCount: number;
    priorContextTokens?: number;
    applyStoredSummarySpans?: boolean;
}

export interface PromptPruningResult {
    messages: PromptMessage[];
    stats: {
        originalTokenEstimate: number;
        postToolPolicyTokenEstimate: number;
        postSegmentTokenEstimate: number;
        finalTokenEstimate: number;
    };
}

export class PromptPruningService {
    constructor(
        private readonly conversationStore: ConversationStore,
        private readonly conversationId: string
    ) {}

    async prune(config: PromptPruningConfig): Promise<PromptPruningResult> {
        const result = await prunePrompt({
            messages: config.messages,
            maxTokens: config.maxTokens,
            pruningThreshold: 1,
            preservedTailCount: config.preservedTailCount,
            priorContextTokens: config.priorContextTokens,
            conversationKey: config.applyStoredSummarySpans === false ? undefined : this.conversationId,
            summaryStore: config.applyStoredSummarySpans === false
                ? undefined
                : {
                    load: (key) => this.conversationStore.loadSummarySpans(key),
                },
            promptToolPolicy: defaultToolPolicy,
            beforeToolCompression,
            retrievalToolName: "fs_read",
            retrievalToolArgName: "tool",
        });

        return {
            messages: result.messages as PromptMessage[],
            stats: result.stats,
        };
    }
}
