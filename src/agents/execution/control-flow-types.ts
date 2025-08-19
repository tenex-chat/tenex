import type { Complete, CompletionSummary, ConversationResult } from "@/tools/core";

// Type guards for tool outputs

export function isComplete(output: unknown): output is Complete {
    // Check for new completion intent format
    if (
        typeof output === "object" &&
        output !== null &&
        "type" in output &&
        output.type === "completion" &&
        "content" in output &&
        typeof output.content === "string"
    ) {
        return true;
    }
    
    // Legacy format check (keep for backwards compatibility)
    return (
        typeof output === "object" &&
        output !== null &&
        "type" in output &&
        output.type === "complete" &&
        "completion" in output &&
        isCompletionSummary(output.completion)
    );
}

export function isCompletionSummary(completion: unknown): completion is CompletionSummary {
    return (
        typeof completion === "object" &&
        completion !== null &&
        "response" in completion &&
        typeof completion.response === "string" &&
        "summary" in completion &&
        typeof completion.summary === "string"
    );
}

export function isConversationResult(result: unknown): result is ConversationResult {
    return (
        typeof result === "object" &&
        result !== null &&
        "response" in result &&
        typeof result.response === "string" &&
        "summary" in result &&
        typeof result.summary === "string" &&
        "success" in result &&
        typeof result.success === "boolean"
    );
}