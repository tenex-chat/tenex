import type { PromptToolCompressionPlanEntry } from "ai-sdk-context-management";
import { isDelegateToolName } from "@/agents/tool-names";

export function beforeToolCompression(
    entries: readonly PromptToolCompressionPlanEntry[]
): PromptToolCompressionPlanEntry[] {
    return entries.map((entry) => (
        entry.entryType === "tool-result" && isDelegateToolName(entry.toolName)
            ? { ...entry, decision: { policy: "keep" } }
            : entry
    ));
}
