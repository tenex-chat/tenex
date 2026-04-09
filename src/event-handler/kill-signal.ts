import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { NostrInboundAdapter } from "@/nostr/NostrInboundAdapter";
import { RuntimeIngressService } from "@/services/ingress/RuntimeIngressService";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

interface EventHandlerContext {
    agentExecutor: AgentExecutor;
    inboundAdapter?: Pick<NostrInboundAdapter, "toEnvelope">;
    runtimeIngressService?: Pick<RuntimeIngressService, "handleChatMessage">;
}

/**
 * Delegation kill signals are control-plane wake-ups, not conversation content.
 * Route only aborted delegation-marker events into the normal ingress stack so
 * dispatch can resume the immediate parent without appending marker traffic to
 * the killed child transcript.
 */
export const handleKillSignal = async (
    event: NDKEvent,
    context: EventHandlerContext
): Promise<void> => {
    const markerStatus = event.tagValue("delegation-marker");
    if (markerStatus !== "aborted") {
        logger.debug("[kill-signal] Ignoring non-aborted delegation marker", {
            eventId: event.id,
            status: markerStatus,
        });
        return;
    }

    const inboundAdapter = context.inboundAdapter ?? new NostrInboundAdapter();
    const runtimeIngressService = context.runtimeIngressService ?? new RuntimeIngressService();
    const envelope = inboundAdapter.toEnvelope(event);

    logger.info("[kill-signal] Forwarding aborted delegation marker to runtime ingress", {
        eventId: event.id,
        delegationConversationId: envelope.metadata.delegationConversationId,
        parentConversationId: envelope.metadata.delegationParentConversationId,
    });

    await runtimeIngressService.handleChatMessage({
        envelope,
        agentExecutor: context.agentExecutor,
        adapter: "NostrInboundAdapter:kill-signal",
    });
};
