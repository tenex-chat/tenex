import type { Conversation } from "@/conversations/types";
import { getAgentSlugFromEvent, isEventFromUser } from "@/nostr/utils";
import { getProjectContext } from "@/services/ProjectContext";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { Message } from "multi-llm-ts";

/**
 * Convert NDKEvent array to Message array for LLM consumption
 */
export function buildHistoryMessages(history: NDKEvent[]): Message[] {
    const messages: Message[] = [];
    const projectCtx = getProjectContext();

    for (const event of history) {
        if (!event.content) continue;

        if (isEventFromUser(event)) {
            messages.push(new Message("user", event.content));
        } else {
            // It's from an agent, find out which one
            const agentSlug = getAgentSlugFromEvent(event);
            const agent = agentSlug ? projectCtx.agents.get(agentSlug) : undefined;
            // Default to "Agent" if the agent can't be found for some reason
            const agentName = agent ? agent.name : "Agent";

            // Add system message for attribution
            messages.push(new Message("system", `The following message is from ${agentName}:`));
            // Keep the original content clean
            messages.push(new Message("assistant", event.content));
        }
    }

    return messages;
}

/**
 * Check if we need to add a current user message
 * (when the last event in history isn't the current user request)
 */
export function needsCurrentUserMessage(conversation: Conversation): boolean {
    if (conversation.history.length === 0) return true;

    const lastEvent = conversation.history[conversation.history.length - 1];
    if (!lastEvent) return true;
    return !isEventFromUser(lastEvent);
}

/**
 * Extract the latest user message from conversation history
 */
export function getLatestUserMessage(conversation: Conversation): string | null {
    // Find the most recent user message
    for (let i = conversation.history.length - 1; i >= 0; i--) {
        const event = conversation.history[i];
        if (event && isEventFromUser(event) && event.content) {
            return event.content;
        }
    }
    return null;
}
