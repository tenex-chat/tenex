import { TagExtractor } from "@/nostr/TagExtractor";
import { getProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import { shortenConversationId } from "@/utils/conversation-id";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { RALRegistry } from "@/services/ral";
import { ConversationStore } from "@/conversations/ConversationStore";
import { trace, SpanStatusCode, context as otelContext } from "@opentelemetry/api";

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
    // Early exit: check for e-tags BEFORE creating a span to avoid trace noise
    // Events without e-tags cannot be delegation completions
    const eTags = TagExtractor.getETags(event);
    if (eTags.length === 0) {
        return { recorded: false };
    }

    const span = tracer.startSpan("tenex.delegation.completion_check", {
        attributes: {
            "event.id": event.id || "",
            "event.pubkey": event.pubkey,
            "event.kind": event.kind || 0,
            "delegation.etag_count": eTags.length,
        },
    }, otelContext.active());

    try {
        const ralRegistry = RALRegistry.getInstance();

        // Try e-tags in reverse order (last to first) as per NIP-10 convention
        // The last e-tag is typically the direct reply target in threaded conversations
        let location = null;
        let delegationEventId = null;

        for (let i = eTags.length - 1; i >= 0; i--) {
            const eTag = eTags[i];
            span.addEvent("trying_delegation_etag", {
                "delegation.event_id": eTag,
                "etag.index": i,
            });

            // Look up the pending delegation to get context for validation
            const pendingInfo = ralRegistry.findDelegation(eTag);

            if (!pendingInfo?.pending) {
                // No pending delegation found for this e-tag, try next one
                span.addEvent("no_pending_delegation", {
                    "delegation.event_id": eTag,
                });
                continue;
            }

            // Validate that the event author is the delegated agent
            // This prevents OTHER agents from falsely completing delegations
            if (event.pubkey !== pendingInfo.pending.recipientPubkey) {
                span.addEvent("completion_sender_mismatch", {
                    "delegation.event_id": eTag,
                    "expected.recipient_pubkey": pendingInfo.pending.recipientPubkey.substring(0, 12),
                    "actual.sender_pubkey": event.pubkey.substring(0, 12),
                    "validation.matched": false,
                });
                logger.debug("[handleDelegationCompletion] Ignoring event - sender is not the delegated agent", {
                    delegationEventId: eTag.substring(0, 8),
                    expectedRecipient: pendingInfo.pending.recipientPubkey.substring(0, 12),
                    actualSender: event.pubkey.substring(0, 12),
                });
                continue; // Skip to next e-tag
            }

            span.addEvent("completion_sender_validated", {
                "delegation.event_id": eTag,
                "expected.recipient_pubkey": pendingInfo.pending.recipientPubkey.substring(0, 12),
                "actual.sender_pubkey": event.pubkey.substring(0, 12),
                "validation.matched": true,
            });

            // DEFENSE-IN-DEPTH: Early exit for killed delegations.
            // The authoritative check is in RALRegistry.recordCompletion(), but we check
            // here too using the isDelegationKilled() helper to avoid unnecessary work.
            if (ralRegistry.isDelegationKilled(eTag)) {
                span.addEvent("completion_skipped_delegation_killed", {
                    "delegation.event_id": eTag,
                    "delegation.killed_at": pendingInfo.pending.killedAt,
                });
                logger.info("[handleDelegationCompletion] Ignoring completion - delegation was killed", {
                    delegationEventId: eTag.substring(0, 8),
                    killedAt: pendingInfo.pending.killedAt,
                    completionEventId: event.id?.substring(0, 8),
                });
                continue; // Skip to next e-tag - this delegation was killed
            }

            // Record the completion (looks up RAL internally via delegation conversation ID)
            // NOTE: We no longer build/pass fullTranscript here. The marker-based system
            // (RALResolver + MessageBuilder) reads the conversation transcript directly from
            // ConversationStore when expanding delegation markers. Storing redundant transcripts
            // in CompletedDelegation was causing unnecessary memory/disk bloat.
            const result = ralRegistry.recordCompletion({
                delegationConversationId: eTag,
                recipientPubkey: event.pubkey,
                response: event.content,
                completedAt: Date.now(),
            });

            if (result) {
                location = result;
                delegationEventId = eTag;

                // Add the completion event to the delegation conversation store.
                // This ensures getDelegationMessages() can return the user's response
                // when building the delegation marker transcript. Without this, ask
                // conversations would show "transcript unavailable" instead of the
                // actual user response.
                // See: naddr1qvzqqqr4gupzqkmm302xww6uyne99rnhl5kjj53wthjypm2qaem9uz9fdf3hzcf0qyghwumn8ghj7ar9dejhstnrdpshgtcq9p382emxd9uz6en0d3kx7am4wqkkjmn2v43hg6t0dckhzat9w4jj6cmvv4shy6twvullqw7x
                const delegationStore = ConversationStore.get(eTag);
                if (delegationStore) {
                    try {
                        await ConversationStore.addEvent(eTag, event);
                        span.addEvent("completion_event_added_to_delegation_store", {
                            "delegation.conversation_id": shortenConversationId(eTag),
                        });
                    } catch (addEventError) {
                        // Don't throw after recordCompletion has already run.
                        // The completion is recorded - only transcript storage failed.
                        logger.warn("[handleDelegationCompletion] Failed to add completion event to delegation store", {
                            delegationEventId: eTag.substring(0, 8),
                            completionEventId: event.id?.substring(0, 8),
                            error: addEventError instanceof Error ? addEventError.message : String(addEventError),
                        });
                        span.addEvent("completion_event_add_failed", {
                            "delegation.conversation_id": shortenConversationId(eTag),
                            "error": addEventError instanceof Error ? addEventError.message : String(addEventError),
                        });
                    }
                }

                break; // Found a matching delegation
            }
        }

        if (!location) {
            span.addEvent("no_waiting_ral", {
                "delegation.etags_checked": eTags.length,
                "delegation.first_etag": eTags[0],
            });
            span.setStatus({ code: SpanStatusCode.OK });
            return { recorded: false };
        }

        span.setAttribute("delegation.event_id", delegationEventId || "unknown");

        // Get the target agent for logging
        const projectCtx = getProjectContext();

        // Note: We don't spawn an execution here - AgentDispatchService handles that
        // via delegationTarget detection. This handler just records the completion.

        // Get counts from conversation storage
        const pendingDelegations = ralRegistry.getConversationPendingDelegations(
            location.agentPubkey, location.conversationId, location.ralNumber
        );
        const completedDelegations = ralRegistry.getConversationCompletedDelegations(
            location.agentPubkey, location.conversationId, location.ralNumber
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
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            "delegation.event_id": delegationEventId!, // Non-null when location is set
            "responder.pubkey": event.pubkey,
            "response.length": event.content?.length || 0,
        });
        span.setStatus({ code: SpanStatusCode.OK });

        logger.info("[handleDelegationCompletion] Recorded delegation completion", {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            delegationEventId: delegationEventId!.substring(0, 8),
            agentSlug,
            conversationId: location.conversationId.substring(0, 8),
            completionEventId: event.id?.substring(0, 8),
            completedCount: completedDelegations.length,
            pendingCount: pendingDelegations.length,
        });

        return {
            recorded: true,
            agentSlug,
            conversationId: location.conversationId,
            pendingCount: pendingDelegations.length,
        };
    } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
    } finally {
        span.end();
    }
}
