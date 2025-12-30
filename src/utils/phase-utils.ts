import type { ExecutionContext } from "@/agents/execution/types";
import type { EventContext } from "@/nostr/AgentEventEncoder";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

export interface PhaseContext {
    phase?: string;
    phaseInstructions?: string;
}

/**
 * Extract phase context from triggering event if it contains delegation with phase tags
 */
export function extractPhaseContext(triggeringEvent: NDKEvent): PhaseContext | undefined {
    // Check if this is a delegation by looking for the tool tag
    const toolTag = triggeringEvent.tags.find(
        (tag) => tag[0] === "tool" && tag[1] === "delegate"
    );
    if (!toolTag) {
        return undefined;
    }

    // Extract phase name from phase tag
    const phaseTag = triggeringEvent.tags.find((tag) => tag[0] === "phase");
    if (!phaseTag || !phaseTag[1]) {
        return undefined;
    }

    // Extract phase instructions from phase-instructions tag (optional)
    const phaseInstructionsTag = triggeringEvent.tags.find(
        (tag) => tag[0] === "phase-instructions"
    );

    return {
        phase: phaseTag[1],
        phaseInstructions: phaseInstructionsTag?.[1],
    };
}

/**
 * Create EventContext for publishing events
 */
export function createEventContext(context: ExecutionContext, model?: string): EventContext {
    const conversation = context.getConversation();
    // Extract phase directly from triggering event if it's a phase delegation
    const phaseContext = extractPhaseContext(context.triggeringEvent);

    return {
        triggeringEvent: context.triggeringEvent,
        rootEvent: { id: conversation?.getRootEventId() ?? context.triggeringEvent.id },
        conversationId: context.conversationId,
        model: model ?? context.agent.llmConfig,
        phase: phaseContext?.phase,
    };
}
