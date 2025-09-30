import type { Conversation, ConversationCoordinator } from "@/conversations";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { getProjectContext } from "@/services";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
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
   * Handle orphaned replies by fetching the thread from the network
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

    const rootEventId = event.tagValue("E");
    if (!rootEventId) {
      logger.warn(chalk.yellow("Orphaned reply has no E tag, cannot fetch thread"));
      return undefined;
    }

    logger.info(
      chalk.yellow(
        `Fetching conversation thread for orphaned reply, root event: ${rootEventId}`
      )
    );

    const { getNDK } = await import("@/nostr/ndkClient");
    const ndk = getNDK();

    const events = await ndk.fetchEvents([
      { ids: [rootEventId] },
      { "#E": [rootEventId] },
      { "#e": [rootEventId] },
    ]);

    const eventsArray = Array.from(events);
    const rootEvent = eventsArray.find(e => e.id === rootEventId);

    if (!rootEvent) {
      logger.warn(chalk.yellow(`Could not fetch root event ${rootEventId} from network`));
      return undefined;
    }

    const replies = eventsArray.filter(e => e.id !== rootEventId);

    logger.info(
      chalk.green(
        `Fetched root event and ${replies.length} replies`
      )
    );

    const conversation = await this.conversationCoordinator.createConversation(rootEvent);
    if (!conversation) {
      return undefined;
    }

    replies.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

    for (const reply of replies) {
      await this.conversationCoordinator.addEvent(conversation.id, reply);
    }

    if (event.id !== rootEvent.id && !replies.some(r => r.id === event.id)) {
      await this.conversationCoordinator.addEvent(conversation.id, event);
    }

    return conversation;
  }
}
