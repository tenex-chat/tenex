import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Fragment for debug mode meta-cognitive analysis
 * Applied when the user includes #debug in their message
 */
export const debugModeFragment: PromptFragment = {
  id: "debug-mode",
  priority: 100, // High priority to ensure it appears after system prompt
  template: (data: { enabled: boolean }) => {
    if (!data.enabled) return "";

    return `
=== DEBUG MODE: META-COGNITIVE ANALYSIS REQUESTED ===

The user has included "#debug" in their message. They are asking you to explain your decision-making process.

Provide a transparent, honest analysis of:

1. **System Prompt Influence**: Which specific parts of your system prompt or instructions guided this decision
2. **Reasoning Chain**: The step-by-step thought process that led to your choice
3. **Alternatives Considered**: Other approaches you evaluated but didn't choose, and why
4. **Assumptions Made**: Any implicit assumptions about the project, user needs, or context
5. **Constraints Applied**: Technical, architectural, or guideline constraints that limited options
6. **Confidence Level**: How certain you were about this decision and any doubts you had
7. **Pattern Matching**: If you followed a common pattern or best practice, explain why it seemed applicable

Be completely transparent about your internal process. If you made a mistake or could have done better, acknowledge it. The goal is to help the user understand exactly how you arrived at your decision.
=== END DEBUG MODE ===`;
  },
};

// Note: Fragment is registered in the fragments/index.ts file

/**
 * Helper function to check if debug mode is enabled
 */
export function isDebugMode(triggeringEvent?: NDKEvent): boolean {
  return triggeringEvent?.content?.includes("#debug") || false;
}