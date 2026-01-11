import { TagExtractor } from "@/nostr/TagExtractor";
import { getProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { RALRegistry } from "@/services/ral";
import { trace, SpanStatusCode, context as otelContext } from "@opentelemetry/api";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { DelegationMessage } from "@/services/ral/types";

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
    }, otelContext.active());

    try {
        const ralRegistry = RALRegistry.getInstance();

        // Find which delegation this responds to (via e-tags)
        // For threaded conversations, we need to check ALL e-tags, not just the first one
        // NIP-10: The last 'e' tag is the reply target, but we should try all to find a matching delegation
        const eTags = TagExtractor.getETags(event);
        if (eTags.length === 0) {
            span.addEvent("no_e_tag");
            span.setStatus({ code: SpanStatusCode.OK });
            return { recorded: false };
        }

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

            // Attempt to build a real transcript from the conversation history
            // This captures user interventions and multi-turn exchanges
            let fullTranscript: DelegationMessage[] | undefined;
            try {
                const store = ConversationStore.get(eTag);
                if (store) {
                    const allMessages = store.getAllMessages();
                    // Filter for meaningful communication (not internal noise):
                    // - Must be text messages
                    // - Must have p-tags (targeted to specific recipients)
                    fullTranscript = allMessages
                        .filter(
                            (msg) =>
                                msg.messageType === "text" &&
                                msg.targetedPubkeys &&
                                msg.targetedPubkeys.length > 0
                        )
                        .map((msg) => ({
                            senderPubkey: msg.pubkey,
                            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                            recipientPubkey: msg.targetedPubkeys![0], // Primary recipient
                            content: msg.content,
                            timestamp: msg.timestamp ?? Date.now(),
                        }));

                    span.addEvent("loaded_delegation_transcript", {
                        "delegation.event_id": eTag,
                        "transcript.message_count": fullTranscript.length,
                    });

                    // Include the current completion event in the transcript
                    // since it hasn't been stored yet when this handler runs
                    const pTags = TagExtractor.getPTags(event);
                    if (event.content && pTags.length > 0) {
                        fullTranscript.push({
                            senderPubkey: event.pubkey,
                            recipientPubkey: pTags[0],
                            content: event.content,
                            timestamp: event.created_at ? event.created_at * 1000 : Date.now(),
                        });
                        span.addEvent("appended_current_event_to_transcript", {
                            "event.content_length": event.content.length,
                            "transcript.final_count": fullTranscript.length,
                        });
                    }
                }
            } catch (err) {
                // If we fail to load the conversation history, fall back to default behavior
                logger.warn("[handleDelegationCompletion] Failed to load conversation history for transcript", {
                    delegationEventId: eTag.substring(0, 8),
                    error: err instanceof Error ? err.message : String(err),
                });
                span.addEvent("transcript_load_failed", {
                    "delegation.event_id": eTag,
                    error: err instanceof Error ? err.message : String(err),
                });
            }

            // Record the completion (looks up RAL internally via delegation conversation ID)
            const result = ralRegistry.recordCompletion({
                delegationConversationId: eTag,
                recipientPubkey: event.pubkey,
                response: event.content,
                completedAt: Date.now(),
                fullTranscript: fullTranscript && fullTranscript.length > 0 ? fullTranscript : undefined,
            });

            if (result) {
                location = result;
                delegationEventId = eTag;
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

        // Note: We don't spawn an execution here - the normal event routing in reply.ts
        // handles that via delegationTarget detection. This handler just records the completion.

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
            "conversation.id": location.conversationId,
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
