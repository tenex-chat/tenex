import type { Phase } from "@/conversations/phases";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Completion guidance for SPECIALISTS ONLY.
 * Orchestrator doesn't use complete() tool.
 * No conditionals, no isOrchestrator checks.
 */
interface SpecialistCompletionGuidanceArgs {
  phase: Phase;
}

export const specialistCompletionGuidanceFragment: PromptFragment<SpecialistCompletionGuidanceArgs> =
  {
    id: "specialist-completion-guidance",
    priority: 2,
    template: ({ phase }) => {
      // CHAT and BRAINSTORM phases don't require termination
      if (phase === "CHAT" || phase === "BRAINSTORM") {
        return `## Phase Completion
**${phase}**: No explicit termination required. Simply respond naturally to the user. If the user is clear on wanting to move forward use the complete() tool with a report of what needs to happen next.`;
      }

      const phaseGuidance: Record<Phase, string> = {
        CHAT: "", // Handled above
        BRAINSTORM: "", // Handled above
        PLAN: "**PLAN**: Use complete() after delivering full architectural plan",
        EXECUTE: "**EXECUTE**: Use complete() after implementation with summary of what was built",
        VERIFICATION: "**VERIFICATION**: Use complete() after testing with pass/fail status",
        CHORES: "**CHORES**: Use complete() after finishing documentation/cleanup",
        REFLECTION: "**REFLECTION**: Use complete() after recording lessons",
      };

      return `## Complete() Tool Usage
${phaseGuidance[phase] || "USE complete() when task is finished"}

**Never use complete() for**: conversations, updates, questions
**Always routes to**: orchestrator for phase control`;
    },
  };

// Register the fragment
fragmentRegistry.register(specialistCompletionGuidanceFragment);
