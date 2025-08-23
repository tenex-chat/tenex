import type { Complete, CompletionSummary, ConversationResult } from "@/tools/core";

// Type guards for tool outputs

export function isComplete(output: unknown): output is Complete {
  return (
    typeof output === "object" &&
    output !== null &&
    "type" in output &&
    output.type === "completion" &&
    "content" in output &&
    typeof output.content === "string"
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
