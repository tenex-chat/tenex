import type { AgentInstance } from "@/agents/types";
import type { Conversation, ConversationCoordinator } from "@/conversations";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
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
    
    // Method 1: Check for explicit completion (tool:complete with e-tag)
    if (event.tagValue("tool") === "complete") {
      const delegationId = AgentEventDecoder.getDelegationRequestId(event);
      if (delegationId) {
        delegationContext = registry.getDelegationContextByTaskId(delegationId);
        logger.debug("[DelegationCompletionHandler] Explicit completion detected", {
          delegationId: delegationId?.substring(0, 8),
          found: !!delegationContext
        });
      }
    }
    
    // Method 2: Natural response detection - check all p-tags
    if (!delegationContext) {
      const pTags = event.tags.filter(tag => tag[0] === "p");
      
      for (const pTag of pTags) {
        const delegatingAgentPubkey = pTag[1];
        if (!delegatingAgentPubkey) continue;
        
        // Check if there's a pending delegation from p-tagged agent to sender
        delegationContext = registry.getDelegationContext(
          conversation.id,
          delegatingAgentPubkey,  // who delegated
          event.pubkey           // who is responding
        );
        
        if (delegationContext && delegationContext.status === "pending") {
          logger.info("[DelegationCompletionHandler] Natural delegation response detected", {
            conversationId: conversation.id.substring(0, 8),
            from: event.pubkey.substring(0, 16),
            to: delegatingAgentPubkey.substring(0, 16),
          });
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
