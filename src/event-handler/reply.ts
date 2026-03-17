import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { NostrInboundAdapter } from "@/nostr/NostrInboundAdapter";
import { RuntimeIngressService } from "@/services/ingress/RuntimeIngressService";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

interface EventHandlerContext {
    agentExecutor: AgentExecutor;
    inboundAdapter?: Pick<NostrInboundAdapter, "toEnvelope">;
    runtimeIngressService?: Pick<RuntimeIngressService, "handleChatMessage">;
}

/**
 * Main entry point for handling chat messages.
 */
export const handleChatMessage = async (
    event: NDKEvent,
    context: EventHandlerContext
): Promise<void> => {
    const inboundAdapter = context.inboundAdapter ?? new NostrInboundAdapter();
    const runtimeIngressService = context.runtimeIngressService ?? new RuntimeIngressService();
    const envelope = inboundAdapter.toEnvelope(event);
    await runtimeIngressService.handleChatMessage({
        envelope,
        legacyEvent: event,
        agentExecutor: context.agentExecutor,
        adapter: "NostrInboundAdapter",
    });
};
