import type { AgentInstance } from "@/agents/types";
import type { Conversation, ConversationCoordinator } from "@/conversations";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { getProjectContext } from "@/services";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";

const logInfo = logger.info.bind(logger);

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
export  class DelegationCompletionHandler {
  /**
   * Process a delegation completion event using the DelegationRegistry
   */
  static async handleDelegationCompletion(
    event: NDKEvent,
    _conversation: Conversation,
    conversationCoordinator: ConversationCoordinator
  ): Promise<DelegationCompletionResult> {
    // For delegation completions, the delegation request ID is what we're replying to
    const delegationId = AgentEventDecoder.getDelegationRequestId(event);
    logger.debug("[DelegationCompletionHandler] Delegation ID from event:", delegationId?.substring(0, 8) || "NONE");

    if (!delegationId) {
      logger.debug("[DelegationCompletionHandler] No delegation ID found - aborting");
      return { shouldReactivate: false };
    }

    // Use DelegationRegistry to get context directly
    const registry = DelegationRegistry.getInstance();
    const delegationContext = registry.getDelegationContext(delegationId);

    if (!delegationContext) {
      logger.warn("[DelegationCompletionHandler] No delegation context found for delegation", {
        delegationId: delegationId.substring(0, 8),
      });
      return { shouldReactivate: false };
    }

    logger.debug("[DelegationCompletionHandler] Found delegation context", {
      delegationId: delegationId.substring(0, 8),
      delegatingAgent: delegationContext.delegatingAgent.slug,
      status: delegationContext.status,
      batchId: delegationContext.delegationBatchId,
    });

    // Record the completion in the registry
    try {
      const result = await registry.recordTaskCompletion({
        taskId: delegationId,
        completionEventId: event.id,
        response: event.content,
        summary: event.tagValue("summary"),
        completedBy: event.pubkey,
      });

      // Check if this batch was already handled synchronously
      const wasSyncHandled = registry.isBatchSyncHandled(result.batchId);
      if (wasSyncHandled) {
        logger.info("[DelegationCompletionHandler] ✅ Batch was already handled synchronously, skipping reactivation", {
          delegationId: delegationId.substring(0, 8),
          batchId: result.batchId,
        });
        return { shouldReactivate: false };
      }

      const isAsyncFallback = !DelegationRegistry.getInstance().listenerCount(`${result.batchId}:completion`);
      
      logger.info(isAsyncFallback 
        ? "[DelegationCompletionHandler] 🔄 ASYNC FALLBACK: Processing completion (no sync listener)"
        : "[DelegationCompletionHandler] 🔁 Processing completion (sync listener active)", {
        delegationId: delegationId.substring(0, 8),
        batchComplete: result.batchComplete,
        remainingTasks: result.remainingTasks,
        batchId: result.batchId,
        mode: isAsyncFallback ? "async-fallback" : "synchronous",
      });

      if (result.batchComplete) {
        logger.info(isAsyncFallback
          ? "[DelegationCompletionHandler] 🔄 ASYNC FALLBACK: Reactivating agent after delegation"
          : "[DelegationCompletionHandler] ℹ️ Delegation complete (sync handler likely processed)", {
          agent: result.delegatingAgentSlug,
          batchId: result.batchId,
          mode: isAsyncFallback ? "async-reactivation" : "sync-already-handled",
        });

        // Find the target agent
        const targetAgent = getProjectContext().getAgent(result.delegatingAgentSlug);
        if (!targetAgent) {
          logger.error("[DelegationCompletionHandler] Could not find delegating agent", {
            agentSlug: result.delegatingAgentSlug,
          });
          return { shouldReactivate: false };
        }

        // Find the original user request to use as reply target
        const delegatingConversation = conversationCoordinator.getConversation(result.conversationId);
        if (!delegatingConversation) {
          logger.warn("[DelegationCompletionHandler] Could not find delegating conversation", {
            conversationId: result.conversationId.substring(0, 8),
          });
          return { shouldReactivate: true, targetAgent };
        }

        // Find first non-agent event (the original user request)
        const projectCtx = getProjectContext();
        const agentPubkeys = new Set([
          projectCtx.pubkey,
          ...Array.from(projectCtx.agents.values()).map((a) => a.pubkey),
        ]);

        const originalUserEvent = delegatingConversation.history?.find(
          (e) => !agentPubkeys.has(e.pubkey)
        );

        if (originalUserEvent) {
          logger.debug("[DelegationCompletionHandler] Found original user event to reply to", {
            eventId: originalUserEvent.id?.substring(0, 8),
            userPubkey: originalUserEvent.pubkey?.substring(0, 8),
          });
        }

        return {
          shouldReactivate: true,
          targetAgent,
          replyTarget: originalUserEvent,
        };
      }
      logInfo(
        chalk.gray(
          `Delegation ${delegationId.substring(0, 8)} completed. Waiting for ${result.remainingTasks} more delegations.`
        )
      );
      return { shouldReactivate: false };
    } catch (error) {
      logger.error("[DelegationCompletionHandler] Failed to record delegation completion", {
        delegationId: delegationId.substring(0, 8),
        error,
      });
      return { shouldReactivate: false };
    }
  }
}
