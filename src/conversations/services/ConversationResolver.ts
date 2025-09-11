import type { Conversation, ConversationCoordinator } from "@/conversations";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { getProjectContext } from "@/services";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";


export interface ConversationResolutionResult {
  conversation: Conversation | undefined;
  isNew?: boolean;
}

/**
 * ConversationResolver encapsulates all logic for finding or creating conversations
 * based on incoming Nostr events. This centralizes the complex resolution logic
 * that was previously scattered throughout reply.ts.
 */
export class ConversationResolver {
  constructor(
    private conversationCoordinator: ConversationCoordinator
  ) {}

  /**
   * Resolve the conversation for an incoming event.
   * This may find an existing conversation, create a new one for orphaned replies,
   * or use delegation context to find parent conversations.
   */
  async resolveConversationForEvent(event: NDKEvent): Promise<ConversationResolutionResult> {
    // Try standard conversation resolution
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

    const conversation = convRoot
      ? this.conversationCoordinator.getConversationByEvent(convRoot)
      : undefined;

    return { conversation };
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
    logger.info(
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
