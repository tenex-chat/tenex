import type { Phase } from "@/conversations/phases";
import type { Conversation } from "@/conversations/types";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Phase context fragment for specialists.
 * Provides context about the current phase and any transition information.
 */
interface PhaseContextArgs {
    phase: Phase;
    phaseMetadata?: Record<string, any>;
    conversation?: Conversation;
}

export const phaseContextFragment: PromptFragment<PhaseContextArgs> = {
    id: "phase-context",
    priority: 10,
    template: ({ phase, phaseMetadata, conversation }) => {
        const parts: string[] = [];
        
        parts.push(`## Current Phase: ${phase.toUpperCase()}`);
        
        // Get phase context from phase transitions if available
        const phaseContext = getPhaseContext(phase, conversation);
        if (phaseContext) {
            parts.push(`### Phase Context\n${phaseContext}`);
        }
        
        // Add any phase metadata
        if (phaseMetadata?.goal) {
            parts.push(`### Phase Goal\n${phaseMetadata.goal}`);
        }
        
        return parts.join('\n\n');
    }
};

/**
 * Helper to extract phase context from phase transitions
 */
function getPhaseContext(targetPhase: Phase, conversation?: Conversation): string | null {
    if (!conversation?.phaseTransitions?.length) {
        return null;
    }

    // Find the most recent transition to the target phase
    const relevantTransition = [...conversation.phaseTransitions]
        .reverse()
        .find(t => t.toPhase === targetPhase);

    if (relevantTransition?.message) {
        return relevantTransition.message;
    }

    return null;
}

// Register the fragment
fragmentRegistry.register(phaseContextFragment);