import type { Conversation } from "@/conversations/types";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Phase context fragment.
 * Provides context about the current phase and any transition information.
 */
interface PhaseContextArgs {
  phase: string;
  phaseMetadata?: Record<string, unknown>;
  conversation?: Conversation;
}

export const phaseContextFragment: PromptFragment<PhaseContextArgs> = {
  id: "phase-context",
  priority: 10,
  template: ({ phase, phaseMetadata }) => {
    const parts: string[] = [];

    parts.push(`## Current Phase: ${phase.toUpperCase()}`);

    // Add any phase metadata
    if (phaseMetadata?.goal) {
      parts.push(`### Phase Goal\n${phaseMetadata.goal}`);
    }

    return parts.join("\n\n");
  },
};

// Register the fragment
fragmentRegistry.register(phaseContextFragment);
