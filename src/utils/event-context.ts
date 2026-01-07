import type { EventContext } from "@/nostr/AgentEventEncoder";
import type { ToolExecutionContext } from "@/tools/types";

/**
 * Create EventContext for publishing events.
 * Requires ToolExecutionContext which guarantees ralNumber is available.
 */
export function createEventContext(context: ToolExecutionContext, model?: string): EventContext {
    const conversation = context.getConversation();

    return {
        triggeringEvent: context.triggeringEvent,
        rootEvent: { id: conversation.getRootEventId() ?? context.triggeringEvent.id },
        conversationId: context.conversationId,
        model: model ?? context.agent.llmConfig,
        ralNumber: context.ralNumber,
    };
}
