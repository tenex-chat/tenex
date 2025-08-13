import type { Phase } from "@/conversations/phases";
import type { Conversation } from "@/conversations/types";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import "@/prompts/fragments/phase";
import "@/prompts/fragments/agentFragments";
import "@/prompts/fragments/agent-completion-guidance";

/**
 * Builds phase-specific instructions to be injected as a system message
 * when an agent transitions to a new phase.
 * 
 * This includes:
 * - Current phase context and any transition information
 * - Phase-specific constraints
 * - Phase-specific completion guidance
 */
export function buildPhaseInstructions(
    phase: Phase,
    conversation?: Conversation,
    isOrchestrator: boolean = false
): string {
    // Orchestrators should not receive dynamic phase instructions
    // as they output strict JSON and handle phases differently
    if (isOrchestrator) {
        return "";
    }

    const builder = new PromptBuilder()
        .add("phase-context", {
            phase,
            phaseMetadata: conversation?.metadata,
            conversation,
        })
        .add("phase-constraints", {
            phase,
        })
        .add("agent-completion-guidance", {
            phase,
            isOrchestrator: false,
        });

    return builder.build();
}

/**
 * Formats a phase transition message for an agent that is
 * re-entering the conversation in a different phase.
 */
export function formatPhaseTransitionMessage(
    lastSeenPhase: Phase,
    currentPhase: Phase,
    phaseInstructions: string
): string {
    return `=== PHASE TRANSITION ===

You were last active in the ${lastSeenPhase.toUpperCase()} phase.
The conversation has now moved to the ${currentPhase.toUpperCase()} phase.

${phaseInstructions}

Please adjust your behavior according to the new phase requirements.`;
}