import type { AgentInstance } from "@/agents/types";
import type { Conversation, ConversationCoordinator } from "@/conversations";
import { TagExtractor } from "@/nostr/TagExtractor";
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { RALRegistry } from "@/services/ral";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("tenex.delegation");

export interface DelegationCompletionResult {
    shouldReactivate: boolean;
    targetAgent?: AgentInstance;
    replyTarget?: NDKEvent;
    /** If true, this is a RAL resumption (not a fresh execution) */
    isResumption?: boolean;
    /** If true, this event was recognized as completing a delegation (even if not all complete yet) */
    wasDelegationCompletion?: boolean;
}

/**
 * DelegationCompletionHandler encapsulates all logic for processing delegation completion events.
 * This includes updating the RALRegistry, recording the completion, and queuing the event
 * for injection into the paused agent execution.
 */

// biome-ignore lint/complexity/noStaticOnlyClass: <explanation>
export class DelegationCompletionHandler {
    /**
     * Process a delegation completion event using RALRegistry
     *
     * Flow:
     * 1. Find which delegation this responds to (via e-tag)
     * 2. Look up which RAL is waiting for this delegation
     * 3. Record the completion
     * 4. Check if all delegations are complete
     * 5. If all complete, trigger RAL resumption
     */
    static async handleDelegationCompletion(
        event: NDKEvent,
        conversation: Conversation,
        _conversationCoordinator: ConversationCoordinator
    ): Promise<DelegationCompletionResult> {
        const span = tracer.startSpan("tenex.delegation.completion_check", {
            attributes: {
                "event.id": event.id || "",
                "event.pubkey": event.pubkey,
                "event.kind": event.kind || 0,
                "conversation.id": conversation.id,
            },
        });

        try {
            const ralRegistry = RALRegistry.getInstance();

            // Find which delegation this responds to (via e-tag)
            const delegationEventId = TagExtractor.getFirstETag(event);
            if (!delegationEventId) {
                span.addEvent("no_e_tag");
                span.setStatus({ code: SpanStatusCode.OK });
                logger.debug("[DelegationCompletionHandler] No e-tag found in completion event", {
                    eventId: event.id?.substring(0, 8),
                });
                return { shouldReactivate: false };
            }

            span.setAttribute("delegation.event_id", delegationEventId);

            // Look up which agent is waiting for this delegation
            const agentPubkey = ralRegistry.findAgentWaitingForDelegation(delegationEventId);
            if (!agentPubkey) {
                span.addEvent("no_waiting_agent", {
                    "delegation.event_id": delegationEventId,
                });
                span.setStatus({ code: SpanStatusCode.OK });
                logger.debug("[DelegationCompletionHandler] No agent waiting for this delegation", {
                    delegationEventId: delegationEventId.substring(0, 8),
                    eventId: event.id?.substring(0, 8),
                });
                return { shouldReactivate: false };
            }

            span.setAttribute("agent.pubkey", agentPubkey);

            // Get the target agent
            const projectCtx = getProjectContext();
            const targetAgent = projectCtx.getAgentByPubkey(agentPubkey);
            if (!targetAgent) {
                span.addEvent("agent_not_found");
                span.setStatus({ code: SpanStatusCode.ERROR });
                logger.warn("[DelegationCompletionHandler] Could not find agent by pubkey", {
                    agentPubkey: agentPubkey.substring(0, 8),
                    delegationEventId: delegationEventId.substring(0, 8),
                });
                return { shouldReactivate: false };
            }

            span.setAttribute("agent.slug", targetAgent.slug);

            logger.info("[DelegationCompletionHandler] Processing delegation completion", {
                delegationEventId: delegationEventId.substring(0, 8),
                agentSlug: targetAgent.slug,
                completionEventId: event.id?.substring(0, 8),
                responderPubkey: event.pubkey.substring(0, 8),
            });

            span.addEvent("completion_detected", {
                "delegation.event_id": delegationEventId,
                "responder.pubkey": event.pubkey,
                "response.length": event.content?.length || 0,
            });

            // Record the completion
            ralRegistry.recordCompletion(agentPubkey, {
                eventId: delegationEventId,
                recipientPubkey: event.pubkey,
                response: event.content,
                responseEventId: event.id,
                completedAt: Date.now(),
            });

            // Check if all delegations are now complete
            const allComplete = ralRegistry.allDelegationsComplete(agentPubkey);
            const state = ralRegistry.getStateByAgent(agentPubkey);

            span.setAttributes({
                "delegation.all_complete": allComplete,
                "delegation.pending_count": state?.pendingDelegations.length || 0,
                "delegation.completed_count": state?.completedDelegations.length || 0,
            });

            if (allComplete) {
                span.addEvent("all_delegations_complete", {
                    "action": "trigger_resumption",
                });
                span.setStatus({ code: SpanStatusCode.OK });

                logger.info("[DelegationCompletionHandler] All delegations complete, triggering resumption", {
                    agentSlug: targetAgent.slug,
                    agentPubkey: agentPubkey.substring(0, 8),
                });

                // Find the original triggering event to use as reply target
                const replyTarget = conversation.history?.[0];

                return {
                    shouldReactivate: true,
                    targetAgent,
                    replyTarget,
                    isResumption: true,
                };
            }

            // Still waiting for more delegations
            span.addEvent("waiting_for_more", {
                "remaining": state?.pendingDelegations.length || 0,
            });
            span.setStatus({ code: SpanStatusCode.OK });

            logger.info("[DelegationCompletionHandler] Waiting for more delegations", {
                agentSlug: targetAgent.slug,
                remainingPending: state?.pendingDelegations.length || 0,
                completedCount: state?.completedDelegations.length || 0,
            });

            // Return wasDelegationCompletion so the event handler knows to skip routing to this agent
            return { shouldReactivate: false, targetAgent, wasDelegationCompletion: true };
        } catch (error) {
            span.recordException(error as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
        } finally {
            span.end();
        }
    }
}
