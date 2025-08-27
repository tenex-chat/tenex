import type { Phase } from "@/conversations/phases";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Completion guidance for SPECIALISTS ONLY.
 * Natural completion - no explicit tool needed.
 */
interface SpecialistCompletionGuidanceArgs {
  phase: Phase;
}

export const specialistCompletionGuidanceFragment: PromptFragment<SpecialistCompletionGuidanceArgs> =
  {
    id: "specialist-completion-guidance",
    priority: 2,
    template: ({ phase }) => {
      // CHAT and BRAINSTORM phases continue naturally
      if (phase === "CHAT" || phase === "BRAINSTORM") {
        return `## Phase Completion
**${phase}**: Simply respond naturally to the user. If the user is clear on wanting to move forward, provide a report of what needs to happen next.`;
      }

      const phaseGuidance: Record<Phase, string> = {
        CHAT: "", // Handled above
        BRAINSTORM: "", // Handled above
        PLAN: "**PLAN**: Complete naturally after delivering full architectural plan",
        EXECUTE: "**EXECUTE**: Complete naturally after implementation with summary of what was built",
        VERIFICATION: "**VERIFICATION**: Complete naturally after testing with pass/fail status",
        CHORES: "**CHORES**: Complete naturally after finishing documentation/cleanup",
        REFLECTION: "**REFLECTION**: Complete naturally after recording lessons",
      };

      return `## Natural Completion
${phaseGuidance[phase] || "Your work completes naturally when you finish your task"}

**Simply finish your work**: The system handles completion automatically
**Results route to**: orchestrator for phase control`;
    },
  };

// Register the fragment
fragmentRegistry.register(specialistCompletionGuidanceFragment);