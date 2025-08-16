import { getProjectContext, isProjectContextInitialized } from "@/services";
import type { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import { EXECUTION_TAGS, LLM_TAGS } from "./tags";
import type { LLMMetadata } from "./types";
import type { Conversation } from "@/conversations/types";
import { getTotalExecutionTimeSeconds } from "@/conversations/executionTime";

/**
 * Check if an event is from an agent (either project agent or individual agent)
 * @param event - The NDK event to check
 * @returns true if the event is from an agent, false if from a user
 */
export function isEventFromAgent(event: NDKEvent): boolean {
    const projectCtx = getProjectContext();

    // Check if it's from the project itself
    if (projectCtx.pubkey === event.pubkey) {
        return true;
    }

    // Check if it's from any of the registered agents
    for (const [_, agent] of projectCtx.agents) {
        if (agent.pubkey === event.pubkey) {
            return true;
        }
    }

    return false;
}

/**
 * Check if an event is from a user (not from an agent)
 * @param event - The NDK event to check
 * @returns true if the event is from a user, false if from an agent
 */
export function isEventFromUser(event: NDKEvent): boolean {
    return !isEventFromAgent(event);
}

/**
 * Get the agent slug if the event is from an agent
 * @param event - The NDK event to check
 * @returns The agent slug if found, undefined otherwise
 */
export function getAgentSlugFromEvent(event: NDKEvent): string | undefined {
    if (!event.pubkey) return undefined;

    if (!isProjectContextInitialized()) {
        // Project context not initialized
        return undefined;
    }

    const projectCtx = getProjectContext();
    for (const [slug, agent] of projectCtx.agents) {
        if (agent.pubkey === event.pubkey) {
            return slug;
        }
    }

    return undefined;
}

/**
 * Add common project tags to an event
 * @param event - The NDK event to add tags to
 * @param project - The NDK project to tag
 */
export function addProjectTags(event: NDKEvent, project: NDKProject): void {
    event.tag(project);
}

/**
 * Add conversation context tags to an event
 * @param event - The NDK event to add tags to
 * @param conversation - The conversation context
 * @param triggeringEvent - The event that triggered this response
 */
export function addConversationTags(
    event: NDKEvent,
    conversation: Conversation,
    triggeringEvent?: NDKEvent
): void {
    // Add current phase tag
    event.tag(["phase", conversation.phase]);
    
    // Add execution time tag
    const totalSeconds = getTotalExecutionTimeSeconds(conversation);
    event.tag([EXECUTION_TAGS.NET_TIME, totalSeconds.toString()]);
    
    // Add voice mode tag if the triggering event has it
    if (triggeringEvent?.tagValue("mode") === "voice") {
        event.tag(["mode", "voice"]);
    }
}

/**
 * Add LLM metadata tags to an event
 * @param event - The NDK event to add tags to
 * @param metadata - The LLM metadata to add
 */
export function addLLMMetadataTags(event: NDKEvent, metadata: LLMMetadata): void {
    event.tag([LLM_TAGS.MODEL, metadata.model]);
    event.tag([LLM_TAGS.COST_USD, metadata.cost.toString()]);
    event.tag([LLM_TAGS.PROMPT_TOKENS, metadata.promptTokens.toString()]);
    event.tag([LLM_TAGS.COMPLETION_TOKENS, metadata.completionTokens.toString()]);
    event.tag([LLM_TAGS.TOTAL_TOKENS, metadata.totalTokens.toString()]);
    
    if (metadata.contextWindow) {
        event.tag([LLM_TAGS.CONTEXT_WINDOW, metadata.contextWindow.toString()]);
    }
    if (metadata.maxCompletionTokens) {
        event.tag([LLM_TAGS.MAX_COMPLETION_TOKENS, metadata.maxCompletionTokens.toString()]);
    }
    if (metadata.systemPrompt) {
        // event.tag(["llm-system-prompt", metadata.systemPrompt]);
    }
    if (metadata.userPrompt) {
        event.tag(["llm-user-prompt", metadata.userPrompt]);
    }
    if (metadata.rawResponse) {
        event.tag(["llm-raw-response", metadata.rawResponse]);
    }
}

/**
 * Add agent identification tags to an event
 * @param event - The NDK event to add tags to
 * @param agentPubkey - The agent's public key
 * @param agentSlug - Optional agent slug
 */
export function addAgentTags(event: NDKEvent, agentPubkey: string, agentSlug?: string): void {
    event.tag(["p", agentPubkey]);
    if (agentSlug) {
        event.tag(["agent", agentSlug]);
    }
}
