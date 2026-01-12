import type { EventContext } from "@/nostr/AgentEventEncoder";
import type { ToolExecutionContext } from "@/tools/types";

/**
 * Create EventContext for publishing events.
 * Handles missing conversation context gracefully (e.g., in MCP context).
 */
export function createEventContext(context: ToolExecutionContext, model?: string): EventContext {
    const conversation = context.getConversation?.();
    const rootEventId = conversation?.getRootEventId() ?? context.triggeringEvent?.id;

    return {
        triggeringEvent: context.triggeringEvent,
        rootEvent: rootEventId ? { id: rootEventId } : {},
        conversationId: context.conversationId,
        model: model ?? context.agent.llmConfig,
        ralNumber: context.ralNumber,
    };
}
