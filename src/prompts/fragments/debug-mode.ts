import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { PromptFragment } from "../core/types";

/**
 * Fragment for debug mode meta-cognitive analysis
 * Applied when the user includes #debug in their message
 */
export const debugModeFragment: PromptFragment<{ enabled: boolean }> = {
    id: "debug-mode",
    priority: 100, // High priority to ensure it appears after system prompt
    template: (data) => {
        if (!data.enabled) return "";

        return `
=== DEBUG MODE: META-COGNITIVE ANALYSIS REQUESTED ===

The user has included "#debug" in their message. They are asking you to explain your decision-making process.

Provide a transparent, honest analysis of:

1. Transparent response of the decision-making process. <-- This is the critical part.
2. Your understanding of the current status of the current conversation. What was said recently? Who did what? Which agents are involved and what was the last thing they accomplished. Include textual quotes from the agents and users that are involved in the conversation.
3. **System Prompt Influence**: Which specific parts of your system prompt or instructions guided this decision
4. **Reasoning Chain**: The step-by-step thought process that led to your choice
5. **Alternatives Considered**: Other approaches you evaluated but didn't choose, and why
6. **Assumptions Made**: Any implicit assumptions about the project, user needs, or context
7. **Constraints Applied**: Technical, architectural, or guideline constraints that limited options
8. **Confidence Level**: How certain you were about this decision and any doubts you had
9. **Pattern Matching**: If you followed a common pattern or best practice, explain why it seemed applicable

Be completely transparent about your internal process. If you made a mistake or could have done better, acknowledge it. The goal is to help the user understand exactly how you arrived at your decision.

ONLY reply to the question being asked; do NOT perform any other action, do NOT call any tool. Do not apologize. Just transparently respond.
=== END DEBUG MODE ===`;
    },
};

// Note: Fragment is registered in the fragments/index.ts file

/**
 * Helper function to check if debug mode is enabled
 */
export function isDebugMode(triggeringEvent: NDKEvent | undefined): boolean {
    if (!triggeringEvent || !triggeringEvent.content) {
        return false;
    }
    return triggeringEvent.content.includes("#debug");
}
