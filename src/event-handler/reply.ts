import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { AgentDispatchService } from "@/services/dispatch/AgentDispatchService";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

interface EventHandlerContext {
    agentExecutor: AgentExecutor;
}

/**
 * Main entry point for handling chat messages.
 */
export const handleChatMessage = async (
    event: NDKEvent,
    context: EventHandlerContext
): Promise<void> => {
    const dispatcher = AgentDispatchService.getInstance();
    await dispatcher.dispatch(event, context);
};
