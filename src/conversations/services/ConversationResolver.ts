import type { ConversationCoordinator } from "./ConversationCoordinator";
import type { ConversationStore } from "../ConversationStore";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { getProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import chalk from "chalk";

export interface ConversationResolutionResult {
    conversation: ConversationStore | undefined;
    isNew?: boolean;
}

/**
 * ConversationResolver encapsulates all logic for finding or creating conversations
 * based on incoming Nostr events.
 */
export class ConversationResolver {
    constructor(private conversationCoordinator: ConversationCoordinator) {}

    /**
     * Resolve the conversation for an incoming event.
     */
    async resolveConversationForEvent(event: NDKEvent): Promise<ConversationResolutionResult> {
        const activeSpan = trace.getActiveSpan();
        const replyTarget = AgentEventDecoder.getReplyTarget(event);

        // If event has an 'e' tag (reply), try to find existing conversation
        if (replyTarget) {
            const conversation = this.conversationCoordinator.getConversationByEvent(replyTarget);
            if (conversation) {
                activeSpan?.addEvent("conversation.resolved", {
                    "resolution.type": "found_existing",
                    "conversation.id": conversation.id,
                    "conversation.message_count": conversation.getAllMessages().length,
                });
                return { conversation };
            }

            // Has e tag but conversation not found - try orphaned reply handling
            const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);
            const newConversation = await this.handleOrphanedReply(event, replyTarget, mentionedPubkeys);
            if (newConversation) {
                activeSpan?.addEvent("conversation.resolved", {
                    "resolution.type": "created_from_orphan",
                    "conversation.id": newConversation.id,
                    "conversation.message_count": newConversation.getAllMessages().length,
                });
                return { conversation: newConversation, isNew: true };
            }

            activeSpan?.addEvent("conversation.resolution_failed", {
                reason: "conversation_not_found_for_reply_target",
                "reply_target.id": replyTarget,
            });
            return { conversation: undefined };
        }

        // No 'e' tag - this is a NEW conversation, create it
        const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);
        const projectCtx = getProjectContext();
        const isDirectedToAgent = mentionedPubkeys.some((pubkey) =>
            Array.from(projectCtx.agents.values()).some((a) => a.pubkey === pubkey)
        );

        if (!isDirectedToAgent) {
            activeSpan?.addEvent("conversation.resolution_failed", {
                reason: "not_directed_to_agent",
            });
            return { conversation: undefined };
        }

        const conversation = await this.conversationCoordinator.createConversation(event);
        if (conversation) {
            logger.info(chalk.green(`Created new conversation ${conversation.id.substring(0, 8)} from kind:1 event`));
            activeSpan?.addEvent("conversation.resolved", {
                "resolution.type": "created_new",
                "conversation.id": conversation.id,
            });
            return { conversation, isNew: true };
        }

        activeSpan?.addEvent("conversation.resolution_failed", {
            reason: "failed_to_create_conversation",
        });
        return { conversation: undefined };
    }

    /**
     * Handle orphaned replies by fetching the thread from the network
     */
    private async handleOrphanedReply(
        event: NDKEvent,
        replyTargetId: string,
        mentionedPubkeys: string[]
    ): Promise<ConversationStore | undefined> {
        if (mentionedPubkeys.length === 0) {
            return undefined;
        }

        const projectCtx = getProjectContext();
        const isDirectedToAgent = mentionedPubkeys.some((pubkey) =>
            Array.from(projectCtx.agents.values()).some((a) => a.pubkey === pubkey)
        );

        if (!isDirectedToAgent) {
            return undefined;
        }

        logger.info(
            chalk.yellow(
                `Fetching conversation thread for orphaned reply, target: ${replyTargetId.substring(0, 8)}`
            )
        );

        const activeSpan = trace.getActiveSpan();
        activeSpan?.addEvent("conversation.fetching_orphaned_thread", {
            reply_target_id: replyTargetId,
        });

        const { getNDK } = await import("@/nostr/ndkClient");
        const ndk = getNDK();

        // Fetch the reply target event and any events that also reply to it
        const events = await ndk.fetchEvents([
            { ids: [replyTargetId] },
            { "#e": [replyTargetId] },
        ]);

        const eventsArray = Array.from(events);
        const rootEvent = eventsArray.find((e) => e.id === replyTargetId);

        if (!rootEvent) {
            logger.warn(chalk.yellow(`Could not fetch target event ${replyTargetId.substring(0, 8)} from network`));
            activeSpan?.addEvent("conversation.fetch_failed", {
                reason: "target_event_not_found",
                reply_target_id: replyTargetId,
            });
            return undefined;
        }

        const replies = eventsArray.filter((e) => e.id !== replyTargetId);

        logger.info(chalk.green(`Fetched target event and ${replies.length} replies`));
        activeSpan?.addEvent("conversation.thread_fetched", {
            "fetched.reply_count": replies.length,
            "fetched.total_events": eventsArray.length,
        });

        const conversation = await this.conversationCoordinator.createConversation(rootEvent);
        if (!conversation) {
            return undefined;
        }

        replies.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

        for (const reply of replies) {
            await this.conversationCoordinator.addEvent(conversation.id, reply);
        }

        if (event.id !== rootEvent.id && !replies.some((r) => r.id === event.id)) {
            await this.conversationCoordinator.addEvent(conversation.id, event);
        }

        return conversation;
    }
}
