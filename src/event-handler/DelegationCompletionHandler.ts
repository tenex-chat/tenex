import type { AgentInstance } from "@/agents/types";
import type { Conversation, ConversationCoordinator } from "@/conversations";
import { TagExtractor } from "@/nostr/TagExtractor";
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { RALRegistry } from "@/services/ral";

export interface DelegationCompletionResult {
    shouldReactivate: boolean;
    targetAgent?: AgentInstance;
    replyTarget?: NDKEvent;
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
     * 2. Look up which RAL this belongs to
     * 3. Record the completion
     * 4. Queue the event for injection
     * 5. Let the normal event handler flow handle the resume (via injection or new execution)
     */
    static async handleDelegationCompletion(
        event: NDKEvent,
        _conversation: Conversation,
        _conversationCoordinator: ConversationCoordinator
    ): Promise<DelegationCompletionResult> {
        const ralRegistry = RALRegistry.getInstance();

        // Find which delegation this responds to (via e-tag)
        const delegationEventId = TagExtractor.getFirstETag(event);
        if (!delegationEventId) {
            logger.debug("[DelegationCompletionHandler] No e-tag found in completion event", {
                eventId: event.id?.substring(0, 8),
            });
            return { shouldReactivate: false };
        }

        // Look up which RAL this belongs to
        const ralId = ralRegistry.getRalIdForDelegation(delegationEventId);
        if (!ralId) {
            logger.debug("[DelegationCompletionHandler] Not a tracked delegation", {
                delegationEventId: delegationEventId.substring(0, 8),
                eventId: event.id?.substring(0, 8),
            });
            return { shouldReactivate: false };
        }

        // Get the RAL state to find the agent pubkey
        // We need to find which agent this RAL belongs to
        // The ralId is the state.id, but we need to find the agentPubkey
        // We can search through all states to find the one with this ralId
        const projectCtx = getProjectContext();
        const agents = Array.from(projectCtx.agents.values());

        let agentPubkey: string | undefined;
        let targetAgent: AgentInstance | undefined;

        for (const agent of agents) {
            const state = ralRegistry.getStateByAgent(agent.pubkey);
            if (state && state.id === ralId) {
                agentPubkey = agent.pubkey;
                targetAgent = agent;
                break;
            }
        }

        if (!agentPubkey || !targetAgent) {
            logger.warn("[DelegationCompletionHandler] Could not find agent for RAL", {
                ralId: ralId.substring(0, 8),
                delegationEventId: delegationEventId.substring(0, 8),
            });
            return { shouldReactivate: false };
        }

        logger.info("[DelegationCompletionHandler] Processing delegation completion", {
            ralId: ralId.substring(0, 8),
            delegationEventId: delegationEventId.substring(0, 8),
            agentSlug: targetAgent.slug,
            completionEventId: event.id?.substring(0, 8),
        });

        // Record the completion
        ralRegistry.recordCompletion(agentPubkey, {
            eventId: delegationEventId,
            recipientPubkey: event.pubkey,
            response: event.content,
            responseEventId: event.id,
            completedAt: Date.now(),
        });

        // Queue the event for injection
        ralRegistry.queueEvent(agentPubkey, event);

        logger.info("[DelegationCompletionHandler] Queued completion event for injection", {
            agentSlug: targetAgent.slug,
            agentPubkey: agentPubkey.substring(0, 8),
            completionEventId: event.id?.substring(0, 8),
        });

        // Return that this should NOT trigger reactivation
        // The normal event handler flow will handle the resume via injection
        return { shouldReactivate: false };

        /* Original code commented out until RAL migration
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
                delegationEventId: delegationContext.delegationEventId,
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

            const isAsyncFallback = !DelegationRegistryService.getInstance().listenerCount(
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
        */
    }
}
