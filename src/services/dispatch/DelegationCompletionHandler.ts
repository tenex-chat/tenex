import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { ConversationStore } from "@/conversations/ConversationStore";
import { RALRegistry } from "@/services/ral";
import { getProjectContext } from "@/services/projects";
import { shortenConversationId, shortenPubkey } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import { trace, SpanStatusCode, context as otelContext } from "@opentelemetry/api";

const tracer = trace.getTracer("tenex.delegation");

export interface DelegationCompletionResult {
    recorded: boolean;
    agentSlug?: string;
    conversationId?: string;
    pendingCount?: number;
    deferred?: boolean;
}

export async function handleDelegationCompletion(
    envelope: InboundEnvelope
): Promise<DelegationCompletionResult> {
    // ── Implicit-kill branch ────────────────────────────────────────────────
    // Kill-signal envelopes bypass sender validation and recordCompletion().
    // The local abort state was already committed by markParentDelegationKilled
    // before the signal was dispatched, so we only need to resolve the parent
    // wake target and return it.  We must not append anything to the child
    // conversation store here.
    if (envelope.metadata.isKillSignal) {
        const delegationConversationId = envelope.metadata.killSignalDelegationConversationId;
        if (!delegationConversationId) {
            logger.debug("[handleDelegationCompletion] Kill signal missing delegationConversationId, ignoring");
            return { recorded: false };
        }

        const ralRegistry = RALRegistry.getInstance();
        const wakeTarget = ralRegistry.findImplicitKillWakeTarget(delegationConversationId);
        if (!wakeTarget) {
            logger.debug("[handleDelegationCompletion] Kill signal: no aborted wake target found (already consumed or not committed)", {
                delegationConversationId: delegationConversationId.substring(0, 8),
            });
            return { recorded: false };
        }

        const projectCtx = getProjectContext();
        const parentAgent = projectCtx.getAgentByPubkey(wakeTarget.agentPubkey);

        logger.info("[handleDelegationCompletion] Kill signal: resolving implicit aborted completion for parent wake-up", {
            delegationConversationId: delegationConversationId.substring(0, 8),
            parentConversationId: wakeTarget.conversationId.substring(0, 8),
            parentAgentSlug: parentAgent?.slug,
        });

        return {
            recorded: true,
            agentSlug: parentAgent?.slug,
            conversationId: wakeTarget.conversationId,
        };
    }
    // ── End implicit-kill branch ────────────────────────────────────────────

    const eTags = envelope.metadata.replyTargets ?? [];
    if (eTags.length === 0) {
        return { recorded: false };
    }

    const senderPubkey = envelope.principal.linkedPubkey;
    if (!senderPubkey) {
        return { recorded: false };
    }

    const span = tracer.startSpan("tenex.delegation.completion_check", {
        attributes: {
            "event.id": envelope.message.nativeId,
            "event.pubkey": senderPubkey,
            "event.kind": envelope.metadata.eventKind || 0,
            "delegation.etag_count": eTags.length,
        },
    }, otelContext.active());

    try {
        const ralRegistry = RALRegistry.getInstance();
        let location = null;
        let delegationEventId = null;
        let completionDeferred = false;

        for (let index = eTags.length - 1; index >= 0; index -= 1) {
            const eTag = eTags[index];
            span.addEvent("trying_delegation_etag", {
                "delegation.event_id": eTag,
                "etag.index": index,
            });

            const pendingInfo = ralRegistry.findDelegation(eTag);
            if (!pendingInfo?.pending) {
                span.addEvent("no_pending_delegation", {
                    "delegation.event_id": eTag,
                });
                continue;
            }

            if (senderPubkey !== pendingInfo.pending.recipientPubkey) {
                span.addEvent("completion_sender_mismatch", {
                    "delegation.event_id": eTag,
                    "expected.recipient_pubkey": shortenPubkey(pendingInfo.pending.recipientPubkey),
                    "actual.sender_pubkey": shortenPubkey(senderPubkey),
                    "validation.matched": false,
                });
                logger.debug("[handleDelegationCompletion] Ignoring event - sender is not the delegated agent", {
                    delegationEventId: eTag.substring(0, 8),
                    expectedRecipient: shortenPubkey(pendingInfo.pending.recipientPubkey),
                    actualSender: shortenPubkey(senderPubkey),
                });
                continue;
            }

            span.addEvent("completion_sender_validated", {
                "delegation.event_id": eTag,
                "expected.recipient_pubkey": shortenPubkey(pendingInfo.pending.recipientPubkey),
                "actual.sender_pubkey": shortenPubkey(senderPubkey),
                "validation.matched": true,
            });

            if (ralRegistry.isDelegationKilled(eTag)) {
                span.addEvent("completion_skipped_delegation_killed", {
                    "delegation.event_id": eTag,
                    "delegation.killed_at": pendingInfo.pending.killedAt,
                });
                logger.info("[handleDelegationCompletion] Ignoring completion - delegation was killed", {
                    delegationEventId: eTag.substring(0, 8),
                    killedAt: pendingInfo.pending.killedAt,
                    completionEventId: envelope.message.nativeId.substring(0, 8),
                });
                continue;
            }

            const result = ralRegistry.recordCompletion({
                delegationConversationId: eTag,
                recipientPubkey: senderPubkey,
                response: envelope.content,
                completedAt: Math.floor(Date.now() / 1000),
            });

            if (!result) {
                continue;
            }

            const delegationStore = ConversationStore.get(eTag);
            if (delegationStore) {
                try {
                    await ConversationStore.addEnvelope(eTag, envelope);
                    span.addEvent("completion_event_added_to_delegation_store", {
                        "delegation.conversation_id": shortenConversationId(eTag),
                    });
                } catch (addEventError) {
                    logger.warn("[handleDelegationCompletion] Failed to add completion event to delegation store", {
                        delegationEventId: eTag.substring(0, 8),
                        completionEventId: envelope.message.nativeId.substring(0, 8),
                        error: addEventError instanceof Error ? addEventError.message : String(addEventError),
                    });
                    span.addEvent("completion_event_add_failed", {
                        "delegation.conversation_id": shortenConversationId(eTag),
                        error: addEventError instanceof Error ? addEventError.message : String(addEventError),
                    });
                }
            }

            if (result.deferred) {
                completionDeferred = true;
                break;
            }

            location = result;
            delegationEventId = eTag;

            break;
        }

        if (!location) {
            span.addEvent("no_waiting_ral", {
                "delegation.etags_checked": eTags.length,
                "delegation.first_etag": eTags[0],
            });
            span.setStatus({ code: SpanStatusCode.OK });
            return { recorded: false, deferred: completionDeferred };
        }

        const resolvedDelegationEventId = delegationEventId;
        if (!resolvedDelegationEventId) {
            const message =
                `[DelegationCompletionHandler] Missing delegation event id for completion event ${envelope.message.nativeId ?? "unknown"}.`;
            span.addEvent("completion_record_missing_delegation_id", {
                "responder.pubkey": senderPubkey,
                "completion.event_id": envelope.message.nativeId,
            });
            span.setStatus({ code: SpanStatusCode.ERROR, message });
            throw new Error(message);
        }
        span.setAttribute("delegation.event_id", resolvedDelegationEventId);

        const projectCtx = getProjectContext();
        const pendingDelegations = ralRegistry.getConversationPendingDelegations(
            location.agentPubkey,
            location.conversationId,
            location.ralNumber
        );
        const completedDelegations = ralRegistry.getConversationCompletedDelegations(
            location.agentPubkey,
            location.conversationId,
            location.ralNumber
        );

        const targetAgent = projectCtx.getAgentByPubkey(location.agentPubkey);
        const agentSlug = targetAgent?.slug;

        span.setAttributes({
            "agent.pubkey": location.agentPubkey,
            "agent.slug": agentSlug || "unknown",
            "conversation.id": shortenConversationId(location.conversationId),
            "delegation.pending_count": pendingDelegations.length,
            "delegation.completed_count": completedDelegations.length,
        });

        span.addEvent("completion_recorded", {
            "delegation.event_id": resolvedDelegationEventId,
            "responder.pubkey": senderPubkey,
            "response.length": envelope.content.length,
        });
        span.setStatus({ code: SpanStatusCode.OK });

        logger.info("[handleDelegationCompletion] Recorded delegation completion", {
            delegationEventId: resolvedDelegationEventId.substring(0, 8),
            agentSlug,
            conversationId: location.conversationId.substring(0, 8),
            completionEventId: envelope.message.nativeId.substring(0, 8),
            completedCount: completedDelegations.length,
            pendingCount: pendingDelegations.length,
            deferred: false,
        });

        return {
            recorded: true,
            agentSlug,
            conversationId: location.conversationId,
            pendingCount: pendingDelegations.length,
            deferred: false,
        };
    } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
    } finally {
        span.end();
    }
}
