import type { Phase, Conversation } from "@/conversations/types";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Phase context fragment.
 * Provides context about the current phase and any transition information.  
 */
interface PhaseContextArgs {
  phase: Phase;
  phaseMetadata?: Record<string, unknown>;
  conversation?: Conversation;
}

export const phaseContextFragment: PromptFragment<PhaseContextArgs> = {
  id: "phase-context",
  priority: 10,
  template: ({ phase, phaseMetadata, conversation }) => {
    const parts: string[] = [];

    parts.push(`## Current Phase: ${phase.toUpperCase()}`);

    // Add custom phase instructions if available
    if (conversation?.phaseInstructions) {
      parts.push(`### Phase Instructions\n${conversation.phaseInstructions}`);
    }


    // Add any phase metadata
    if (phaseMetadata?.goal) {
      parts.push(`### Phase Goal\n${phaseMetadata.goal}`);
    }

    return parts.join("\n\n");
  },
};

// Register the fragment
fragmentRegistry.register(phaseContextFragment);
