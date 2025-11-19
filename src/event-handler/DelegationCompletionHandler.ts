import type { AgentInstance } from "@/agents/types";
import type { Conversation, ConversationCoordinator } from "@/conversations";
import { TagExtractor } from "@/nostr/TagExtractor";
import { getProjectContext } from "@/services";
import type { DelegationRecord } from "@/services/DelegationRegistry";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";

export interface DelegationCompletionResult {
    shouldReactivate: boolean;
    targetAgent?: AgentInstance;
    replyTarget?: NDKEvent;
}

/**
 * DelegationCompletionHandler encapsulates all logic for processing delegation completion events.
 * This includes updating the DelegationRegistry, determining if all delegations in a batch
 * are complete, and preparing the context for agent reactivation.
 */

// biome-ignore lint/complexity/noStaticOnlyClass: <explanation>
export class DelegationCompletionHandler {
    /**
     * Process a delegation completion event using the DelegationRegistry
     * Updated to use conversation key lookups instead of synthetic IDs
     */
    static async handleDelegationCompletion(
        event: NDKEvent,
        conversation: Conversation,
        conversationCoordinator: ConversationCoordinator
    ): Promise<DelegationCompletionResult> {
        const registry = DelegationRegistry.getInstance();
        let delegationContext: DelegationRecord | undefined;

        logger.info("🔍 [DelegationCompletionHandler] Processing potential delegation completion", {
            eventId: event.id?.substring(0, 8),
            from: event.pubkey.substring(0, 16),
            conversationId: conversation.id.substring(0, 8),
            hasStatusTag: !!TagExtractor.getTagValue(event, "status"),
            status: TagExtractor.getTagValue(event, "status"),
        });

        // We need to find the delegation by conversation key.
        // We know:
        // - The root conversation ID (from the conversation object)
        // - The responder pubkey (from event.pubkey)
        // - We need to find who delegated TO this responder

        // First, let's check if this is a response to a delegation by looking at e-tags
        const eTags = TagExtractor.getETags(event);

        logger.debug("🔍 Checking e-tags for delegation references", {
            eTagCount: eTags.length,
            eTags: eTags.map((id) => id?.substring(0, 8)),
        });

        // For each e-tag, check if it's a delegation event we're tracking
        for (const eTag of eTags) {
            if (!eTag) continue;

            // Use the registry's method to find delegation by event ID and responder
            const potentialContext = registry.findDelegationByEventAndResponder(eTag, event.pubkey);

            if (potentialContext && potentialContext.status === "pending") {
                delegationContext = potentialContext;

                logger.info(
                    "✅ [DelegationCompletionHandler] Found matching delegation via e-tag",
                    {
                        delegationEventId: eTag.substring(0, 8),
                        from: event.pubkey.substring(0, 16),
                        to: potentialContext.delegatingAgent.pubkey.substring(0, 16),
                        status: potentialContext.status,
                        isExplicitCompletion: TagExtractor.getTagValue(event, "status") === "completed",
                    }
                );
                break;
            }
        }

        // Alternative: Try using conversation key if we can determine the delegator
        if (!delegationContext) {
            // Look for p-tags that might indicate who we're responding to
            const pTags = TagExtractor.getPTags(event);
            for (const delegatorPubkey of pTags) {
                if (!delegatorPubkey) continue;

                // Try to find delegation using conversation key
                const potentialContext = registry.getDelegationByConversationKey(
                    conversation.id, // root conversation ID
                    delegatorPubkey, // potential delegator
                    event.pubkey // responder (current event author)
                );

                if (potentialContext && potentialContext.status === "pending") {
                    delegationContext = potentialContext;

                    logger.info(
                        "✅ [DelegationCompletionHandler] Found matching delegation via conversation key",
                        {
                            rootConversationId: conversation.id.substring(0, 8),
                            delegator: delegatorPubkey.substring(0, 16),
                            responder: event.pubkey.substring(0, 16),
                            status: potentialContext.status,
                        }
                    );
                    break;
                }
            }
        }

        if (!delegationContext) {
            logger.debug("[DelegationCompletionHandler] No delegation context found");
            return { shouldReactivate: false };
        }

        logger.debug("[DelegationCompletionHandler] Found delegation context", {
            delegatingAgent: delegationContext.delegatingAgent.slug,
            status: delegationContext.status,
            batchId: delegationContext.delegationBatchId,
        });

        // Record the completion in the registry
        try {
            const result = await registry.recordDelegationCompletion({
                conversationId: delegationContext.delegatingAgent.rootConversationId,
                fromPubkey: delegationContext.delegatingAgent.pubkey,
                toPubkey: event.pubkey,
                completionEventId: event.id,
                response: event.content,
                summary: TagExtractor.getTagValue(event, "summary") ?? undefined,
            });

            // Check if this batch was already handled synchronously
            const wasSyncHandled = registry.isBatchSyncHandled(result.batchId);
            if (wasSyncHandled) {
                logger.info(
                    "[DelegationCompletionHandler] ✅ Batch was already handled synchronously, skipping reactivation",
                    {
                        batchId: result.batchId,
                    }
                );
                return { shouldReactivate: false };
            }

            const isAsyncFallback = !DelegationRegistry.getInstance().listenerCount(
                `${result.batchId}:completion`
            );

            logger.info(
                isAsyncFallback
                    ? "[DelegationCompletionHandler] 🔄 ASYNC FALLBACK: Processing completion (no sync listener)"
                    : "[DelegationCompletionHandler] 🔁 Processing completion (sync listener active)",
                {
                    batchComplete: result.batchComplete,
                    remainingTasks: result.remainingDelegations,
                    batchId: result.batchId,
                    mode: isAsyncFallback ? "async-fallback" : "synchronous",
                }
            );

            if (result.batchComplete) {
                logger.info(
                    isAsyncFallback
                        ? "[DelegationCompletionHandler] 🔄 ASYNC FALLBACK: Reactivating agent after delegation"
                        : "[DelegationCompletionHandler] ℹ️ Delegation complete (sync handler likely processed)",
                    {
                        agent: result.delegatingAgentSlug,
                        batchId: result.batchId,
                        mode: isAsyncFallback ? "async-reactivation" : "sync-already-handled",
                    }
                );

                // Find the target agent
                const targetAgent = getProjectContext().getAgent(result.delegatingAgentSlug);
                if (!targetAgent) {
                    logger.error("[DelegationCompletionHandler] Could not find delegating agent", {
                        agentSlug: result.delegatingAgentSlug,
                    });
                    return { shouldReactivate: false };
                }

                // Find the original user request to use as reply target
                const delegatingConversation = conversationCoordinator.getConversation(
                    result.conversationId
                );
                if (!delegatingConversation) {
                    logger.warn(
                        "[DelegationCompletionHandler] Could not find delegating conversation",
                        {
                            conversationId: result.conversationId.substring(0, 8),
                        }
                    );
                    return { shouldReactivate: true, targetAgent };
                }

                // Find first non-agent event (the original user request)
                const projectCtx = getProjectContext();
                const agentPubkeys = new Set([
                    ...(projectCtx.pubkey ? [projectCtx.pubkey] : []),
                    ...Array.from(projectCtx.agents.values()).map((a) => a.pubkey),
                ]);

                const originalUserEvent = delegatingConversation.history?.find(
                    (e) => !agentPubkeys.has(e.pubkey)
                );

                if (originalUserEvent) {
                    logger.debug(
                        "[DelegationCompletionHandler] Found original user event to reply to",
                        {
                            eventId: originalUserEvent.id?.substring(0, 8),
                            userPubkey: originalUserEvent.pubkey?.substring(0, 8),
                        }
                    );
                }

                return {
                    shouldReactivate: true,
                    targetAgent,
                    replyTarget: originalUserEvent,
                };
            }
            logger.info(
                chalk.gray(
                    `Delegation completed. Waiting for ${result.remainingDelegations} more delegations.`
                )
            );
            return { shouldReactivate: false };
        } catch (error) {
            logger.error("[DelegationCompletionHandler] Failed to record delegation completion", {
                error,
            });
            return { shouldReactivate: false };
        }
    }
}
