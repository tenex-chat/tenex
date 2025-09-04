import type { AgentInstance } from "@/agents/types";
import type { Phase, Conversation } from "@/conversations/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import { isVoiceMode } from "@/prompts/fragments/20-voice-mode";

/**
 * Common fragment composition patterns shared between different prompt builders
 */

/**
 * Add core agent fragments that are common to both project and standalone modes
 */
export function addCoreAgentFragments(
    builder: PromptBuilder,
    agent: AgentInstance,
    phase: Phase,
    conversation?: Conversation,
    agentLessons?: Map<string, NDKAgentLesson[]>,
    triggeringEvent?: NDKEvent
): void {
    // Add voice mode instructions if applicable
    if (isVoiceMode(triggeringEvent)) {
        builder.add("voice-mode", {
            isVoiceMode: true,
        });
    }

    // Add referenced article context if present
    if (conversation?.metadata?.referencedArticle) {
        builder.add("referenced-article", conversation.metadata.referencedArticle);
    }

    // Add retrieved lessons
    builder.add("retrieved-lessons", {
        agent,
        phase,
        conversation,
        agentLessons: agentLessons || new Map(),
    });
}

/**
 * Add specialist-specific fragments
 */
export function addSpecialistFragments(
    builder: PromptBuilder,
    agent: AgentInstance,
    availableAgents: AgentInstance[]
): void {
    // Add available agents for delegations
    builder.add("specialist-available-agents", {
        agents: availableAgents,
        currentAgent: agent,
    });
}

/**
 * Add delegated task context if applicable
 */
export function addDelegatedTaskContext(
    builder: PromptBuilder,
    triggeringEvent?: NDKEvent
): void {
    // Check if this is a delegated task (NDKTask kind 1934)
    const isDelegatedTask = triggeringEvent?.kind === 1934;
    if (isDelegatedTask) {
        builder.add("delegated-task-context", {
            taskDescription: triggeringEvent?.content || "Complete the assigned task",
        });
    }
}

/**
 * Build phase-specific instructions to be injected dynamically
 */
export function buildPhaseInstructions(phase: Phase, conversation?: Conversation): string {
    const builder = new PromptBuilder()
        .add("phase-context", {
            phase,
            phaseMetadata: conversation?.metadata,
            conversation,
        });

    return builder.build();
}

/**
 * Format a phase transition message for an agent that is
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