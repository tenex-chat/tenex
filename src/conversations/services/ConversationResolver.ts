import type { Conversation, ConversationCoordinator } from "@/conversations";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { getProjectContext } from "@/services";
import type { DelegationRegistry } from "@/services/DelegationRegistry";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";

const logInfo = logger.info.bind(logger);

export interface ConversationResolutionResult {
  conversation: Conversation | undefined;
  claudeSessionId?: string;
  isNew?: boolean;
}

/**
 * ConversationResolver encapsulates all logic for finding or creating conversations
 * based on incoming Nostr events. This centralizes the complex resolution logic
 * that was previously scattered throughout reply.ts.
 */
export class ConversationResolver {
  constructor(
    private conversationCoordinator: ConversationCoordinator,
    private delegationRegistry: DelegationRegistry
  ) {}

  /**
   * Resolve the conversation for an incoming event.
   * This may find an existing conversation, create a new one for orphaned replies,
   * or use delegation context to find parent conversations.
   */
  async resolveConversationForEvent(event: NDKEvent): Promise<ConversationResolutionResult> {
    // Try standard conversation resolution first
    const result = await this.findConversationForReply(event);

    // If no conversation found and this could be an orphaned reply, try to create one
    if (!result.conversation && AgentEventDecoder.isOrphanedReply(event)) {
      const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);
      const newConversation = await this.handleOrphanedReply(event, mentionedPubkeys);
      if (newConversation) {
        return {
          conversation: newConversation,
          isNew: true,
        };
      }
    }

    return result;
  }

  /**
   * Find the conversation for a reply event using various strategies
   */
  private async findConversationForReply(event: NDKEvent): Promise<ConversationResolutionResult> {
    const convRoot = AgentEventDecoder.getConversationRoot(event);

    let conversation = convRoot
      ? this.conversationCoordinator.getConversationByEvent(convRoot)
      : undefined;
    let mappedClaudeSessionId: string | undefined;

    // Check if this is a task completion - use registry to find parent conversation
    if (
      AgentEventDecoder.getReferencedKind(event) === "1934" &&
      AgentEventDecoder.isTaskCompletionEvent(event)
    ) {
      const taskId = AgentEventDecoder.getTaskId(event);
      if (taskId) {
        // Use DelegationRegistry to find the parent conversation
        const delegationContext = this.delegationRegistry.getDelegationContext(taskId);
        if (delegationContext) {
          const parentConversation = this.conversationCoordinator.getConversation(
            delegationContext.delegatingAgent.conversationId
          );
          if (parentConversation) {
            conversation = parentConversation;
            logInfo(
              chalk.cyan("Task completion routed to parent conversation: ") +
                chalk.yellow(delegationContext.delegatingAgent.conversationId.substring(0, 8))
            );
          }
        }
      }
    }

    // If no conversation found and this is a reply to an NDKTask (K tag = 1934)
    if (!conversation && AgentEventDecoder.getReferencedKind(event) === "1934") {
      const taskId = AgentEventDecoder.getTaskId(event);
      logger.debug("Checking for conversation for K=1934 event", {
        hasConversation: !!conversation,
        taskId: taskId?.substring(0, 8),
        eventKind: event.kind,
        hasTool: event.tagValue("tool"),
        hasStatus: event.tagValue("status"),
      });

      if (taskId) {
        // Use DelegationRegistry to find the parent conversation
        const delegationContext = this.delegationRegistry.getDelegationContext(taskId);

        if (delegationContext) {
          conversation = this.conversationCoordinator.getConversation(
            delegationContext.delegatingAgent.conversationId
          );

          if (conversation) {
            logInfo(
              chalk.gray("Found conversation via delegation registry: ") +
                chalk.cyan(delegationContext.delegatingAgent.conversationId)
            );
          } else {
            logger.error("Delegation context points to non-existent conversation", {
              taskId: taskId.substring(0, 8),
              conversationId: delegationContext.delegatingAgent.conversationId,
            });
          }
        } else {
          logger.debug("No delegation context found, falling back to task as conversation root");
          // Fallback: The task itself might be the conversation root
          conversation = this.conversationCoordinator.getConversation(taskId);

          if (conversation) {
            const claudeSession = AgentEventDecoder.getClaudeSessionId(event);
            if (claudeSession) {
              logInfo(
                chalk.gray("Found claude-session tag in kind:1111 event: ") +
                  chalk.cyan(claudeSession)
              );
              mappedClaudeSessionId = claudeSession;
            }
          }
        }
      }
    }

    return { conversation, claudeSessionId: mappedClaudeSessionId };
  }

  /**
   * Handle orphaned replies by creating a new conversation
   */
  private async handleOrphanedReply(
    event: NDKEvent,
    mentionedPubkeys: string[]
  ): Promise<Conversation | undefined> {
    if (AgentEventDecoder.getReferencedKind(event) !== "11" || mentionedPubkeys.length === 0) {
      return undefined;
    }

    const projectCtx = getProjectContext();
    const isDirectedToAgent = mentionedPubkeys.some((pubkey) =>
      Array.from(projectCtx.agents.values()).some((a) => a.pubkey === pubkey)
    );

    if (!isDirectedToAgent) {
      return undefined;
    }

    const convRoot = AgentEventDecoder.getConversationRoot(event);
    logInfo(
      chalk.yellow(
        `Creating new conversation for orphaned kTag 11 reply to conversation root: ${convRoot}`
      )
    );

    // Create a synthetic root event based on the reply
    const syntheticRootEvent: NDKEvent = {
      ...event,
      id: convRoot || event.id, // Use conversation root if available, otherwise use the reply's ID
      content: `[Orphaned conversation - original root not found]\n\n${event.content}`,
      tags: event.tags.filter((tag) => tag[0] !== "E" && tag[0] !== "e"), // Remove reply tags
    } as NDKEvent;

    const conversation = await this.conversationCoordinator.createConversation(syntheticRootEvent);

    // Add the actual reply event to the conversation history
    if (conversation && event.id !== conversation.id) {
      await this.conversationCoordinator.addEvent(conversation.id, event);
    }

    return conversation;
  }
}
