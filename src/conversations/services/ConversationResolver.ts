import { ConversationStore } from "../ConversationStore";
import type { MessagePrincipalContext } from "../types";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import {
    getMentionedPubkeys,
    getReplyTarget,
    toNativeId,
} from "@/events/runtime/envelope-classifier";
import { shortenConversationId, shortenEventId } from "@/utils/conversation-id";
import { getNDK } from "@/nostr/ndkClient";
import { NostrInboundAdapter } from "@/nostr/NostrInboundAdapter";
import type { ProjectContext } from "@/services/projects/ProjectContext";
import { logger } from "@/utils/logger";
import { buildDelegationChain } from "@/utils/delegation-chain";
import { trace } from "@opentelemetry/api";
import chalk from "chalk";

export interface ConversationResolutionResult {
    conversation: ConversationStore | undefined;
    isNew?: boolean;
}

/**
 * ConversationResolver encapsulates all logic for finding or creating conversations
 * based on incoming envelopes.
 */
export class ConversationResolver {
    constructor(
        private readonly projectContext: Pick<ProjectContext, "agents" | "project" | "getAgentByPubkey">
    ) {}

    async resolveConversationForEvent(
        envelope: InboundEnvelope,
        principalContext?: MessagePrincipalContext
    ): Promise<ConversationResolutionResult> {
        const activeSpan = trace.getActiveSpan();
        const replyTarget = getReplyTarget(envelope);
        const nativeReplyTarget = replyTarget ? toNativeId(replyTarget) : undefined;

        if (nativeReplyTarget) {
            const conversation = ConversationStore.findByEventId(nativeReplyTarget);
            if (conversation) {
                activeSpan?.addEvent("conversation.resolved", {
                    "resolution.type": "found_existing",
                    "conversation.id": shortenConversationId(conversation.id),
                    "conversation.message_count": conversation.getAllMessages().length,
                });
                return { conversation };
            }

            // Not in memory — try loading from disk before going to the network.
            // The reply target ID is the conversation's root event ID, which maps directly
            // to its on-disk file. ConversationStore.get() handles cross-project lookup
            // automatically, making this the correct path for scheduled tasks that target
            // conversations in a different project.
            const conversationFromDisk = ConversationStore.get(nativeReplyTarget);
            if (conversationFromDisk) {
                logger.debug("[ConversationResolver] Loaded conversation from disk", {
                    conversationId: shortenConversationId(conversationFromDisk.id),
                    replyTargetId: shortenEventId(nativeReplyTarget),
                    projectBinding: envelope.channel.projectBinding,
                });
                activeSpan?.addEvent("conversation.resolved", {
                    "resolution.type": "found_on_disk",
                    "conversation.id": shortenConversationId(conversationFromDisk.id),
                    "conversation.message_count": conversationFromDisk.getAllMessages().length,
                });
                return { conversation: conversationFromDisk };
            }

            const mentionedPubkeys = getMentionedPubkeys(envelope);
            const newConversation = await this.handleOrphanedReply(
                envelope,
                nativeReplyTarget,
                mentionedPubkeys,
                principalContext
            );
            if (newConversation) {
                activeSpan?.addEvent("conversation.resolved", {
                    "resolution.type": "created_from_orphan",
                    "conversation.id": shortenConversationId(newConversation.id),
                    "conversation.message_count": newConversation.getAllMessages().length,
                });
                return { conversation: newConversation, isNew: true };
            }

            logger.warn("[ConversationResolver] Could not resolve conversation for reply target", {
                replyTargetId: shortenEventId(nativeReplyTarget),
                eventId: shortenEventId(envelope.message.nativeId),
                projectBinding: envelope.channel.projectBinding,
            });
            activeSpan?.addEvent("conversation.resolution_failed", {
                reason: "conversation_not_found_for_reply_target",
                "reply_target.id": nativeReplyTarget,
            });
            return { conversation: undefined };
        }

        const mentionedPubkeys = getMentionedPubkeys(envelope);
        const isDirectedToAgent = mentionedPubkeys.some((pubkey) =>
            Array.from(this.projectContext.agents.values()).some((agent) => agent.pubkey === pubkey)
        );

        if (!isDirectedToAgent) {
            activeSpan?.addEvent("conversation.resolution_failed", {
                reason: "not_directed_to_agent",
            });
            return { conversation: undefined };
        }

        const conversation = await ConversationStore.create(envelope, principalContext);
        if (!conversation) {
            activeSpan?.addEvent("conversation.resolution_failed", {
                reason: "failed_to_create_conversation",
            });
            return { conversation: undefined };
        }

        const targetAgentPubkey = mentionedPubkeys.find((pubkey) =>
            Array.from(this.projectContext.agents.values()).some((agent) => agent.pubkey === pubkey)
        );

        if (targetAgentPubkey) {
            const delegationChain = buildDelegationChain(
                envelope,
                targetAgentPubkey,
                this.projectContext.project.pubkey,
                conversation.id,
                this.projectContext
            );

            if (delegationChain && delegationChain.length > 0) {
                conversation.updateMetadata({ delegationChain });
                await conversation.save();

                activeSpan?.addEvent("delegation_chain_built", {
                    "chain.length": delegationChain.length,
                    "chain.display": delegationChain.map((entry) => entry.displayName).join(" → "),
                });

                logger.debug("[ConversationResolver] Built delegation chain for new conversation", {
                    conversationId: shortenConversationId(conversation.id),
                    chainLength: delegationChain.length,
                    chain: delegationChain.map((entry) => entry.displayName).join(" → "),
                });
            }
        }

        logger.info(chalk.green(`Created new conversation ${shortenConversationId(conversation.id)} from kind:1 event`));
        activeSpan?.addEvent("conversation.resolved", {
            "resolution.type": "created_new",
            "conversation.id": shortenConversationId(conversation.id),
        });
        return { conversation, isNew: true };
    }

    private async handleOrphanedReply(
        envelope: InboundEnvelope,
        replyTargetId: string,
        mentionedPubkeys: string[],
        principalContext?: MessagePrincipalContext
    ): Promise<ConversationStore | undefined> {
        if (mentionedPubkeys.length === 0) {
            return undefined;
        }

        const isDirectedToAgent = mentionedPubkeys.some((pubkey) =>
            Array.from(this.projectContext.agents.values()).some((agent) => agent.pubkey === pubkey)
        );

        if (!isDirectedToAgent) {
            return undefined;
        }

        logger.info(
            chalk.yellow(
                `Fetching conversation thread for orphaned reply, target: ${shortenEventId(replyTargetId)}`
            )
        );

        const activeSpan = trace.getActiveSpan();
        activeSpan?.addEvent("conversation.fetching_orphaned_thread", {
            reply_target_id: replyTargetId,
        });

        const ndk = getNDK();
        const inboundAdapter = new NostrInboundAdapter();
        const events = await ndk.fetchEvents([
            { ids: [replyTargetId] },
            { "#e": [replyTargetId] },
        ]);

        const eventsArray = Array.from(events);
        const rootEvent = eventsArray.find((event) => event.id === replyTargetId);
        const rootEnvelope = rootEvent ? inboundAdapter.toEnvelope(rootEvent) : undefined;

        if (!rootEnvelope) {
            logger.warn(chalk.yellow(`Could not fetch target event ${shortenEventId(replyTargetId)} from network`));
            activeSpan?.addEvent("conversation.fetch_failed", {
                reason: "target_event_not_found",
                reply_target_id: replyTargetId,
            });
            return undefined;
        }

        const replyEnvelopes = eventsArray
            .filter((event) => event.id !== replyTargetId)
            .map((event) => inboundAdapter.toEnvelope(event))
            .sort((left, right) => left.occurredAt - right.occurredAt);

        logger.info(chalk.green(`Fetched target event and ${replyEnvelopes.length} replies`));
        activeSpan?.addEvent("conversation.thread_fetched", {
            "fetched.reply_count": replyEnvelopes.length,
            "fetched.total_events": eventsArray.length,
        });

        const conversation = await ConversationStore.create(rootEnvelope);
        if (!conversation) {
            return undefined;
        }

        for (const replyEnvelope of replyEnvelopes) {
            await ConversationStore.addEnvelope(conversation.id, replyEnvelope);
        }

        if (
            envelope.message.nativeId !== rootEnvelope.message.nativeId &&
            !replyEnvelopes.some((replyEnvelope) => replyEnvelope.message.nativeId === envelope.message.nativeId)
        ) {
            await ConversationStore.addEnvelope(conversation.id, envelope, principalContext);
        }

        return conversation;
    }
}
