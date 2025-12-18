import type { Conversation, ConversationCoordinator } from "@/conversations";
import { TagExtractor } from "@/nostr/TagExtractor";
import { getProjectContext } from "@/services/ProjectContext";
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
}

/**
 * DelegationCompletionHandler records delegation completions in the RALRegistry.
 * It does NOT handle routing or resumption - that's handled by normal routing + AgentExecutor.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: <explanation>
export class DelegationCompletionHandler {
    /**
     * Record a delegation completion event in RALRegistry
     *
     * Flow:
     * 1. Find which delegation this responds to (via e-tag)
     * 2. Look up which RAL is waiting for this delegation
     * 3. Record the completion
     *
     * Routing and resumption are handled separately by normal routing + AgentExecutor.
     */
    static async handleDelegationCompletion(
        event: NDKEvent,
        _conversation: Conversation,
        _conversationCoordinator: ConversationCoordinator
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

            // Look up which agent is waiting for this delegation
            const agentPubkey = ralRegistry.findAgentWaitingForDelegation(delegationEventId);
            if (!agentPubkey) {
                span.addEvent("no_waiting_agent", {
                    "delegation.event_id": delegationEventId,
                });
                span.setStatus({ code: SpanStatusCode.OK });
                return { recorded: false };
            }

            // Get the target agent for logging
            const projectCtx = getProjectContext();
            const targetAgent = projectCtx.getAgentByPubkey(agentPubkey);
            const agentSlug = targetAgent?.slug;

            span.setAttributes({
                "agent.pubkey": agentPubkey,
                "agent.slug": agentSlug || "unknown",
            });

            // Record the completion
            ralRegistry.recordCompletion(agentPubkey, {
                eventId: delegationEventId,
                recipientPubkey: event.pubkey,
                recipientSlug: projectCtx.getAgentByPubkey(event.pubkey)?.slug,
                response: event.content,
                responseEventId: event.id,
                completedAt: Date.now(),
            });

            const state = ralRegistry.getStateByAgent(agentPubkey);
            span.setAttributes({
                "delegation.pending_count": state?.pendingDelegations.length || 0,
                "delegation.completed_count": state?.completedDelegations.length || 0,
            });

            span.addEvent("completion_recorded", {
                "delegation.event_id": delegationEventId,
                "responder.pubkey": event.pubkey,
                "response.length": event.content?.length || 0,
            });
            span.setStatus({ code: SpanStatusCode.OK });

            logger.info("[DelegationCompletionHandler] Recorded delegation completion", {
                delegationEventId: delegationEventId.substring(0, 8),
                agentSlug,
                completionEventId: event.id?.substring(0, 8),
                completedCount: state?.completedDelegations.length || 0,
                pendingCount: state?.pendingDelegations.length || 0,
            });

            return { recorded: true, agentSlug };
        } catch (error) {
            span.recordException(error as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
        } finally {
            span.end();
        }
    }
}
