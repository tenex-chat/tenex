import type { AgentInstance } from "@/agents/types";
import type { Conversation, ConversationCoordinator } from "@/conversations";
import type { DelegationRecord } from "@/services/DelegationRegistry";
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
export class DelegationCompletionHandler {
  /**
   * Process a delegation completion event using the DelegationRegistry
   */
  static async handleDelegationCompletion(
    event: NDKEvent,
    conversation: Conversation,
    conversationCoordinator: ConversationCoordinator
  ): Promise<DelegationCompletionResult> {
    const registry = DelegationRegistry.getInstance();
    let delegationContext: DelegationRecord | undefined;
    
    // Method 1: Check for completion (status:completed with e-tag)
    if (event.tagValue("status") === "completed") {
      // For completions, check all e-tags to find the matching delegation
      const eTags = event.getMatchingTags("e");
      for (const eTagArray of eTags) {
        const eTag = eTagArray[1]; // e-tag value is at index 1
        if (!eTag) continue;
        
        const potentialContext = registry.getDelegationContextByTaskId(eTag);
        if (potentialContext) {
          delegationContext = potentialContext;
          logger.debug("[DelegationCompletionHandler] Explicit completion detected", {
            delegationId: eTag.substring(0, 8),
            found: true
          });
          break;
        }
      }
      
      if (!delegationContext && eTags.length > 0) {
        logger.debug("[DelegationCompletionHandler] Explicit completion but no matching delegation found", {
          checkedTags: eTags.map(tag => tag[1]?.substring(0, 8))
        });
      }
    }
    
    // Method 2: Natural response detection - check if this event e-tags a delegation request
    if (!delegationContext) {
      const eTags = event.getMatchingTags("e");
      
      // Check all e-tags to find a matching delegation request
      for (const eTagArray of eTags) {
        const eTag = eTagArray[1]; // e-tag value is at index 1
        if (!eTag) continue;
        
        // Check if this e-tag points to a delegation request we're tracking
        const potentialContext = registry.getDelegationContextByTaskId(eTag);
        
        if (potentialContext && 
            potentialContext.status === "pending" && 
            potentialContext.assignedTo.pubkey === event.pubkey) {
          delegationContext = potentialContext;
          logger.info("[DelegationCompletionHandler] Natural delegation response detected", {
            conversationId: conversation.id.substring(0, 8),
            from: event.pubkey.substring(0, 16),
            to: delegationContext.delegatingAgent.pubkey.substring(0, 16),
            taskId: eTag.substring(0, 8),
          });
          break; // Found a match, stop checking
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
      const result = await registry.recordTaskCompletion({
        conversationId: delegationContext.delegatingAgent.conversationId,
        fromPubkey: delegationContext.delegatingAgent.pubkey,
        toPubkey: event.pubkey,
        completionEventId: event.id,
        response: event.content,
        summary: event.tagValue("summary"),
      });

      // Check if this batch was already handled synchronously
      const wasSyncHandled = registry.isBatchSyncHandled(result.batchId);
      if (wasSyncHandled) {
        logger.info("[DelegationCompletionHandler] ✅ Batch was already handled synchronously, skipping reactivation", {
          batchId: result.batchId,
        });
        return { shouldReactivate: false };
      }

      const isAsyncFallback = !DelegationRegistry.getInstance().listenerCount(`${result.batchId}:completion`);
      
      logger.info(isAsyncFallback 
        ? "[DelegationCompletionHandler] 🔄 ASYNC FALLBACK: Processing completion (no sync listener)"
        : "[DelegationCompletionHandler] 🔁 Processing completion (sync listener active)", {
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
          `Delegation completed. Waiting for ${result.remainingTasks} more delegations.`
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
