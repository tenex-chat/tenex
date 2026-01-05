/**
 * Context enhancers for message generation strategies
 * Purpose: Add special contexts like voice mode, debug mode, delegation completion
 * These are pure functions that take minimal parameters and return enhanced content
 */

import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import { isVoiceMode } from "@/prompts/fragments/20-voice-mode";
import { isDebugMode } from "@/prompts/fragments/debug-mode";
import { getPubkeyService } from "@/services/PubkeyService";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";

/**
 * Add voice mode context if applicable
 * @param messages - The messages array to potentially add to
 * @param triggeringEvent - The event to check for voice mode
 * @param agentName - Name of the agent for logging
 * @returns True if voice mode was added
 */
export async function addVoiceModeContext(
    messages: ModelMessage[],
    triggeringEvent: NDKEvent,
    agentName?: string
): Promise<boolean> {
    if (isVoiceMode(triggeringEvent)) {
        const contextBuilder = new PromptBuilder();
        contextBuilder.add("voice-mode", { isVoiceMode: true });

        const voiceInstructions = await contextBuilder.build();
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
export async function addDebugModeContext(
    messages: ModelMessage[],
    triggeringEvent: NDKEvent,
    agentName?: string
): Promise<boolean> {
    if (isDebugMode(triggeringEvent)) {
        const contextBuilder = new PromptBuilder();
        contextBuilder.add("debug-mode", { enabled: true });

        const debugInstructions = await contextBuilder.build();
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
 * @param hasPendingDelegations - Whether there are still pending delegations
 * @param agentName - Name of the agent for logging
 * @returns True if delegation context was added
 */
export async function addDelegationCompletionContext(
    messages: ModelMessage[],
    isDelegationCompletion: boolean,
    hasPendingDelegations: boolean,
    agentName?: string
): Promise<boolean> {
    if (isDelegationCompletion) {
        const contextBuilder = new PromptBuilder();
        contextBuilder.add("delegation-completion", {
            isDelegationCompletion: true,
            hasPendingDelegations,
        });

        const delegationInstructions = await contextBuilder.build();
        if (delegationInstructions) {
            messages.push({ role: "system", content: delegationInstructions });
        }

        if (agentName) {
            logger.debug("[CONTEXT_ENHANCER] Added delegation completion context", {
                agent: agentName,
                hasPendingDelegations,
            });
        }

        return true;
    }
    return false;
}

/**
 * Add context about who the agent is responding to
 * @param messages - The messages array to add to
 * @param triggeringEvent - The event that triggered this execution
 * @param agentName - Name of the agent for logging
 */
export async function addRespondingToContext(
    messages: ModelMessage[],
    triggeringEvent: NDKEvent,
    agentName?: string
): Promise<void> {
    const nameRepo = getPubkeyService();
    const triggeringUserName = await nameRepo.getName(triggeringEvent.pubkey);

    messages.push({
        role: "system",
        content: `You are responding to @${triggeringUserName}. If you need to consult with a different agent before you're ready to satisfy the request from @${triggeringUserName}, use the delegate or ask tools.`,
    });

    if (agentName) {
        logger.debug("[CONTEXT_ENHANCER] Added responding-to context", {
            agent: agentName,
            respondingTo: triggeringUserName,
        });
    }
}

/**
 * Add all special contexts in one call
 * @param messages - The messages array to add to
 * @param triggeringEvent - The event to check for special modes
 * @param isDelegationCompletion - Whether this is a delegation completion
 * @param hasPendingDelegations - Whether there are still pending delegations
 * @param agentName - Name of the agent for logging
 * @returns Object indicating which contexts were added
 */
export async function addAllSpecialContexts(
    messages: ModelMessage[],
    triggeringEvent: NDKEvent,
    isDelegationCompletion: boolean,
    hasPendingDelegations: boolean,
    agentName?: string
): Promise<{ voiceMode: boolean; debugMode: boolean; delegationMode: boolean }> {
    const result = {
        voiceMode: await addVoiceModeContext(messages, triggeringEvent, agentName),
        debugMode: await addDebugModeContext(messages, triggeringEvent, agentName),
        delegationMode: await addDelegationCompletionContext(messages, isDelegationCompletion, hasPendingDelegations, agentName),
    };

    // Add context about who the agent is responding to
    await addRespondingToContext(messages, triggeringEvent, agentName);

    // Only build combined context if any mode is active
    if (!result.voiceMode && !result.debugMode && !result.delegationMode) {
        return result;
    }

    return result;
}
