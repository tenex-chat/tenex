import { TagExtractor } from "@/nostr/TagExtractor";
import { getProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { RALRegistry } from "@/services/ral";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("tenex.delegation");

export interface DelegationCompletionResult {
    /** Whether a completion was recorded */
    recorded: boolean;
    /** The agent slug that's waiting for this delegation (if any) */
    agentSlug?: string;
    /** The conversation ID where the delegation was made */
    conversationId?: string;
    /** Number of pending delegations remaining */
    pendingCount?: number;
}

/**
 * Record a delegation completion event in RALRegistry.
 * Does NOT handle routing or resumption - that's handled by normal routing + AgentExecutor.
 *
 * Flow:
 * 1. Find which delegation this responds to (via e-tag)
 * 2. Look up which RAL is waiting for this delegation
 * 3. Record the completion
 */
export async function handleDelegationCompletion(
    event: NDKEvent
): Promise<DelegationCompletionResult> {
    const span = tracer.startSpan("tenex.delegation.completion_check", {
        attributes: {
            "event.id": event.id || "",
            "event.pubkey": event.pubkey,
            "event.kind": event.kind || 0,
        },
    });

    try {
        const ralRegistry = RALRegistry.getInstance();

        // Find which delegation this responds to (via e-tag)
        const delegationEventId = TagExtractor.getFirstETag(event);
        if (!delegationEventId) {
            span.addEvent("no_e_tag");
            span.setStatus({ code: SpanStatusCode.OK });
            return { recorded: false };
        }

        span.setAttribute("delegation.event_id", delegationEventId);

        // Get the target agent for logging
        const projectCtx = getProjectContext();

        // Record the completion (looks up RAL internally via delegation conversation ID)
        const state = ralRegistry.recordCompletion({
            delegationConversationId: delegationEventId,
            recipientPubkey: event.pubkey,
            recipientSlug: projectCtx.getAgentByPubkey(event.pubkey)?.slug,
            response: event.content,
            responseEventId: event.id,
            completedAt: Date.now(),
        });

        if (!state) {
            span.addEvent("no_waiting_ral", {
                "delegation.event_id": delegationEventId,
            });
            span.setStatus({ code: SpanStatusCode.OK });
            return { recorded: false };
        }

        const targetAgent = projectCtx.getAgentByPubkey(state.agentPubkey);
        const agentSlug = targetAgent?.slug;

        span.setAttributes({
            "agent.pubkey": state.agentPubkey,
            "agent.slug": agentSlug || "unknown",
            "conversation.id": state.conversationId,
            "delegation.pending_count": state.pendingDelegations.length,
            "delegation.completed_count": state.completedDelegations.length,
        });

        span.addEvent("completion_recorded", {
            "delegation.event_id": delegationEventId,
            "responder.pubkey": event.pubkey,
            "response.length": event.content?.length || 0,
        });
        span.setStatus({ code: SpanStatusCode.OK });

        logger.info("[handleDelegationCompletion] Recorded delegation completion", {
            delegationEventId: delegationEventId.substring(0, 8),
            agentSlug,
            conversationId: state.conversationId.substring(0, 8),
            completionEventId: event.id?.substring(0, 8),
            completedCount: state.completedDelegations.length,
            pendingCount: state.pendingDelegations.length,
        });

        return {
            recorded: true,
            agentSlug,
            conversationId: state.conversationId,
            pendingCount: state.pendingDelegations.length,
        };
    } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
    } finally {
        span.end();
    }
}
