import { PromptFragment } from "@/prompts/core/types";

/**
 * Fragment for phase transition instructions
 * Applied when a phase transition is detected in the conversation history
 */
export const phaseTransitionFragment: PromptFragment = {
  id: "phase-transition",
  priority: 90, // High priority to ensure it appears at the right point
  template: (data: { phase?: string; phaseInstructions?: string }) => {
    if (!data.phase) return "";

    let content = `=== PHASE TRANSITION: ${data.phase.toUpperCase()} ===`;

    if (data.phaseInstructions) {
      content += `\n\n${data.phaseInstructions}`;
    }

    content += "\n\nPlease adjust your behavior according to the phase requirements.";

    return content;
  },
};

// Note: Fragment is registered in the fragments/index.ts file