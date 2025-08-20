import type { AgentInstance } from "@/agents/types";
import type { Conversation, ConversationCoordinator } from "@/conversations";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { getProjectContext } from "@/services";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";

const logInfo = logger.info.bind(logger);

export interface TaskCompletionResult {
  shouldReactivate: boolean;
  targetAgent?: AgentInstance;
  replyTarget?: NDKEvent;
}

/**
 * TaskCompletionHandler encapsulates all logic for processing task completion events.
 * This includes updating the DelegationRegistry, determining if all tasks in a batch
 * are complete, and preparing the context for agent reactivation.
 */
export class TaskCompletionHandler {
  /**
   * Process a task completion event using the DelegationRegistry
   */
  static async handleTaskCompletion(
    event: NDKEvent,
    _conversation: Conversation,
    conversationManager: ConversationCoordinator
  ): Promise<TaskCompletionResult> {
    const taskId = AgentEventDecoder.getTaskId(event);
    logger.debug("[TaskCompletionHandler] Task ID from event:", taskId?.substring(0, 8) || "NONE");

    if (!taskId) {
      logger.debug("[TaskCompletionHandler] No task ID found - aborting");
      return { shouldReactivate: false };
    }

    // Use DelegationRegistry to get context directly
    const registry = DelegationRegistry.getInstance();
    const delegationContext = registry.getDelegationContext(taskId);

    if (!delegationContext) {
      logger.warn("[TaskCompletionHandler] No delegation context found for task", {
        taskId: taskId.substring(0, 8),
      });
      return { shouldReactivate: false };
    }

    logger.debug("[TaskCompletionHandler] Found delegation context", {
      taskId: taskId.substring(0, 8),
      delegatingAgent: delegationContext.delegatingAgent.slug,
      status: delegationContext.status,
      batchId: delegationContext.delegationBatchId,
    });

    // Record the completion in the registry
    try {
      const result = await registry.recordTaskCompletion({
        taskId,
        completionEventId: event.id,
        response: event.content,
        summary: event.tagValue("summary"),
        completedBy: event.pubkey,
      });

      logger.info("[TaskCompletionHandler] Task completion recorded", {
        taskId: taskId.substring(0, 8),
        batchComplete: result.batchComplete,
        remainingTasks: result.remainingTasks,
        batchId: result.batchId,
      });

      if (result.batchComplete) {
        logger.info("[TaskCompletionHandler] All tasks complete, preparing to reactivate agent", {
          agent: result.delegatingAgentSlug,
          batchId: result.batchId,
        });

        // Find the target agent
        const targetAgent = getProjectContext().getAgent(result.delegatingAgentSlug);
        if (!targetAgent) {
          logger.error("[TaskCompletionHandler] Could not find delegating agent", {
            agentSlug: result.delegatingAgentSlug,
          });
          return { shouldReactivate: false };
        }

        // Find the original user request to use as reply target
        const delegatingConversation = conversationManager.getConversation(result.conversationId);
        if (!delegatingConversation) {
          logger.warn("[TaskCompletionHandler] Could not find delegating conversation", {
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
          logger.debug("[TaskCompletionHandler] Found original user event to reply to", {
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
          `Task ${taskId.substring(0, 8)} completed. Waiting for ${result.remainingTasks} more tasks.`
        )
      );
      return { shouldReactivate: false };
    } catch (error) {
      logger.error("[TaskCompletionHandler] Failed to record task completion", {
        taskId: taskId.substring(0, 8),
        error,
      });
      return { shouldReactivate: false };
    }
  }
}
