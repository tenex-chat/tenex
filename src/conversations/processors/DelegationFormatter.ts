import { getAgentSlugFromEvent, isEventFromUser } from "@/nostr/utils";
import { getProjectContext } from "@/services/ProjectContext";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";
import { hasReasoningTag, isOnlyThinkingBlocks, stripThinkingBlocks } from "../utils/content-utils";
import { NostrEntityProcessor } from "./NostrEntityProcessor";

/**
 * Handles formatting of delegation-related messages
 * Single Responsibility: Format delegation contexts and responses
 * Note: Strip <thinking>...</thinking> blocks from conversation history; skip messages that are purely thinking blocks.
 */
export class DelegationFormatter {
    /**
     * Build "Messages While You Were Away" block for catching up on conversation history
     */
    static async buildMissedMessagesBlock(
        events: NDKEvent[],
        agentSlug: string,
        delegationSummary?: string
    ): Promise<ModelMessage> {
        let contextBlock = "=== MESSAGES WHILE YOU WERE AWAY ===\n\n";

        if (delegationSummary) {
            contextBlock += `**Previous context**: ${delegationSummary}\n\n`;
        }

        for (const event of events) {
            const sender = DelegationFormatter.getEventSender(event, agentSlug);
            if (sender && event.content) {
                // Skip events with reasoning tag
                if (hasReasoningTag(event)) {
                    continue;
                }
                // Skip events that are purely thinking blocks
                if (isOnlyThinkingBlocks(event.content)) {
                    continue;
                }

                // Strip thinking blocks from content
                const strippedContent = stripThinkingBlocks(event.content);

                const processed = await NostrEntityProcessor.processEntities(strippedContent);
                contextBlock += `${sender}:\n${processed}\n\n`;
            }
        }

        contextBlock += "=== END OF HISTORY ===\n";
        contextBlock +=
            "Respond to the most recent user message above, considering the context.\n\n";

        return { role: "system", content: contextBlock };
    }

    /**
     * Build delegation responses block
     */
    static buildDelegationResponsesBlock(
        responses: Map<string, NDKEvent>,
        originalRequest: string
    ): ModelMessage {
        let message = "=== DELEGATE RESPONSES RECEIVED ===\n\n";
        message += `You previously delegated the following request to ${responses.size} agent(s):\n`;
        message += `"${originalRequest}"\n\n`;
        message += "Here are all the responses:\n\n";

        const projectCtx = getProjectContext();
        for (const [pubkey, event] of responses) {
            const agent = projectCtx.getAgentByPubkey(pubkey);
            const agentName = agent?.name || pubkey.substring(0, 8);

            // Skip if response has reasoning tag
            if (hasReasoningTag(event)) {
                continue;
            }
            // Skip if response is purely thinking blocks
            if (!event.content || isOnlyThinkingBlocks(event.content)) {
                continue;
            }

            // Strip thinking blocks from response content
            const strippedContent = stripThinkingBlocks(event.content);

            message += `### Response from ${agentName}:\n`;
            message += `${strippedContent}\n\n`;
        }

        message += "=== END OF DELEGATE RESPONSES ===\n\n";
        message += "Now process these responses and complete your task.";

        return { role: "system", content: message };
    }

    /**
     * Helper to determine event sender for display purposes
     */
    private static getEventSender(event: NDKEvent, currentAgentSlug: string): string | null {
        const eventAgentSlug = getAgentSlugFromEvent(event);

        if (isEventFromUser(event)) {
            return "🟢 USER";
        }
        if (eventAgentSlug) {
            const projectCtx = getProjectContext();
            const sendingAgent = projectCtx.agents.get(eventAgentSlug);
            const agentName = sendingAgent ? sendingAgent.name : "Another agent";

            // Mark the agent's own previous messages clearly
            if (eventAgentSlug === currentAgentSlug) {
                return `💬 You (${agentName})`;
            }
            return `💬 ${agentName}`;
        }
        return "💬 Unknown";
    }
}
