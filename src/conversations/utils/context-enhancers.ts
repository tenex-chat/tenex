/**
 * Context enhancers for message generation strategies
 * Purpose: Add special contexts like voice mode, debug mode, and delegation completion
 * These are pure functions that take minimal parameters and return enhanced content
 */

import type { ModelMessage } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import { isDebugMode } from "@/prompts/fragments/debug-mode";
import { isVoiceMode } from "@/prompts/fragments/20-voice-mode";
import { logger } from "@/utils/logger";

/**
 * Add voice mode context if applicable
 * @param messages - The messages array to potentially add to
 * @param triggeringEvent - The event to check for voice mode
 * @param agentName - Name of the agent for logging
 * @returns True if voice mode was added
 */
export function addVoiceModeContext(
    messages: ModelMessage[],
    triggeringEvent: NDKEvent,
    agentName?: string
): boolean {
    if (isVoiceMode(triggeringEvent)) {
        const contextBuilder = new PromptBuilder();
        contextBuilder.add("voice-mode", { isVoiceMode: true });
        
        const voiceInstructions = contextBuilder.build();
        if (voiceInstructions) {
            messages.push({ role: "system", content: voiceInstructions });
        }

        if (agentName) {
            logger.debug("[CONTEXT_ENHANCER] Voice mode activated", { agent: agentName });
        }
        
        return true;
    }
    return false;
}

/**
 * Add debug mode context if applicable
 * @param messages - The messages array to potentially add to
 * @param triggeringEvent - The event to check for debug mode
 * @param agentName - Name of the agent for logging
 * @returns True if debug mode was added
 */
export function addDebugModeContext(
    messages: ModelMessage[],
    triggeringEvent: NDKEvent,
    agentName?: string
): boolean {
    if (isDebugMode(triggeringEvent)) {
        const contextBuilder = new PromptBuilder();
        contextBuilder.add("debug-mode", { enabled: true });
        
        const debugInstructions = contextBuilder.build();
        if (debugInstructions) {
            messages.push({ role: "system", content: debugInstructions });
        }

        if (agentName) {
            logger.debug("[CONTEXT_ENHANCER] Debug mode activated", { agent: agentName });
        }
        
        return true;
    }
    return false;
}

/**
 * Add delegation completion context
 * @param messages - The messages array to add to
 * @param isDelegationCompletion - Whether this is a delegation completion
 * @param agentName - Name of the agent for logging
 * @returns True if delegation context was added
 */
export function addDelegationCompletionContext(
    messages: ModelMessage[],
    isDelegationCompletion: boolean,
    agentName?: string
): boolean {
    if (isDelegationCompletion) {
        const contextBuilder = new PromptBuilder();
        contextBuilder.add("delegation-completion", {
            isDelegationCompletion: true
        });

        const delegationInstructions = contextBuilder.build();
        if (delegationInstructions) {
            messages.push({ role: "system", content: delegationInstructions });
        }

        if (agentName) {
            logger.debug("[CONTEXT_ENHANCER] Added delegation completion context", { agent: agentName });
        }
        
        return true;
    }
    return false;
}

/**
 * Add all special contexts in one call
 * @param messages - The messages array to add to
 * @param triggeringEvent - The event to check for special modes
 * @param isDelegationCompletion - Whether this is a delegation completion
 * @param agentName - Name of the agent for logging
 * @returns Object indicating which contexts were added
 */
export function addAllSpecialContexts(
    messages: ModelMessage[],
    triggeringEvent: NDKEvent,
    isDelegationCompletion: boolean,
    agentName?: string
): { voiceMode: boolean; debugMode: boolean; delegationMode: boolean } {
    const result = {
        voiceMode: addVoiceModeContext(messages, triggeringEvent, agentName),
        debugMode: addDebugModeContext(messages, triggeringEvent, agentName),
        delegationMode: addDelegationCompletionContext(messages, isDelegationCompletion, agentName)
    };

    // Only build combined context if any mode is active
    if (!result.voiceMode && !result.debugMode && !result.delegationMode) {
        return result;
    }

    return result;
}

/**
 * Create a marker message for important events
 * @param message - The marker message content
 * @returns A system message with the marker
 */
export function createMarkerMessage(message: string): ModelMessage {
    return {
        role: "system",
        content: message
    };
}

/**
 * Add a triggering event marker
 * @param messages - The messages array to add to
 * @param eventId - The ID of the triggering event for logging
 */
export function addTriggeringEventMarker(
    messages: ModelMessage[],
    eventId?: string
): void {
    messages.push(createMarkerMessage("═══ IMPORTANT: THE FOLLOWING IS THE MESSAGE TO RESPOND TO. ═══"));
    
    if (eventId) {
        logger.debug("[CONTEXT_ENHANCER] Added triggering event marker", {
            eventId: eventId.substring(0, 8)
        });
    }
}