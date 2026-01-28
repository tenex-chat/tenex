import type { EventContext } from "@/nostr/types";
import type { ToolExecutionContext } from "@/tools/types";

export interface CreateEventContextOptions {
    model?: string;
    /** Incremental LLM runtime in milliseconds since last event was published */
    llmRuntime?: number;
}

/**
 * Create EventContext for publishing events.
 * Handles missing conversation context gracefully (e.g., in MCP context).
 */
export function createEventContext(
    context: ToolExecutionContext,
    options?: CreateEventContextOptions | string
): EventContext {
    // Support legacy call signature: createEventContext(context, model)
    const opts: CreateEventContextOptions = typeof options === "string"
        ? { model: options }
        : options ?? {};

    const conversation = context.getConversation?.();
    const rootEventId = conversation?.getRootEventId() ?? context.triggeringEvent?.id;

    return {
        triggeringEvent: context.triggeringEvent,
        rootEvent: rootEventId ? { id: rootEventId } : {},
        conversationId: context.conversationId,
        model: opts.model ?? context.agent.llmConfig,
        ralNumber: context.ralNumber,
        llmRuntime: opts.llmRuntime,
    };
}
