import { ConversationStore } from "../ConversationStore";
import type { ConversationMetadata, MessagePrincipalContext } from "../types";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import {
    getMentionedPubkeys,
    getReplyTarget,
    toNativeId,
} from "@/events/runtime/envelope-classifier";
import { shortenConversationId } from "@/utils/conversation-id";
import { getNDK } from "@/nostr/ndkClient";
import { NostrInboundAdapter } from "@/nostr/NostrInboundAdapter";
import { getProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import { buildDelegationChain } from "@/utils/delegation-chain";
import { NDKArticle } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import chalk from "chalk";
import { formatAnyError } from "@/lib/error-formatter";

/**
 * Fetch a kind 30023 (NDKArticle) from an a-tag reference.
 * @param aTagValue - The a-tag value in format "30023:pubkey:d-tag"
 * @returns The article metadata or null if not found
 */
async function fetchReferencedArticle(
    aTagValue: string
): Promise<ConversationMetadata["referencedArticle"] | null> {
    try {
        const parts = aTagValue.split(":");
        if (parts.length < 3 || parts[0] !== "30023") {
            return null;
        }

        const [, pubkey, ...dTagParts] = parts;
        const dTag = dTagParts.join(":");

        const ndk = getNDK();
        const filter = {
            kinds: [30023],
            authors: [pubkey],
            "#d": [dTag],
        };

        const events = await ndk.fetchEvents(filter);
        if (events.size === 0) {
            logger.debug(chalk.yellow(`Referenced article not found: ${aTagValue}`));
            return null;
        }

        const event = Array.from(events)[0];
        const article = NDKArticle.from(event);

        logger.info(chalk.cyan(`📄 Fetched referenced article: "${article.title || dTag}"`));

        return {
            title: article.title || dTag,
            content: article.content || "",
            dTag,
        };
    } catch (error) {
        logger.debug(chalk.yellow(`Failed to fetch referenced article: ${formatAnyError(error)}`));
        return null;
    }
}

async function extractReferencedArticle(
    envelope: InboundEnvelope
): Promise<ConversationMetadata["referencedArticle"] | null> {
    const articleATag = envelope.metadata.articleReferences?.find((tag) => tag.startsWith("30023:"));
    if (!articleATag) {
        return null;
    }

    return fetchReferencedArticle(articleATag);
}

export interface ConversationResolutionResult {
    conversation: ConversationStore | undefined;
    isNew?: boolean;
}

/**
 * ConversationResolver encapsulates all logic for finding or creating conversations
 * based on incoming envelopes.
 */
export class ConversationResolver {
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

            activeSpan?.addEvent("conversation.resolution_failed", {
                reason: "conversation_not_found_for_reply_target",
                "reply_target.id": nativeReplyTarget,
            });
            return { conversation: undefined };
        }

        const mentionedPubkeys = getMentionedPubkeys(envelope);
        const projectCtx = getProjectContext();
        const isDirectedToAgent = mentionedPubkeys.some((pubkey) =>
            Array.from(projectCtx.agents.values()).some((agent) => agent.pubkey === pubkey)
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

        const referencedArticle = await extractReferencedArticle(envelope);
        if (referencedArticle) {
            conversation.updateMetadata({ referencedArticle });
            await conversation.save();

            activeSpan?.addEvent("referenced_article_loaded", {
                "article.title": referencedArticle.title,
                "article.dTag": referencedArticle.dTag,
                "article.content_length": referencedArticle.content.length,
            });
        }

        const targetAgentPubkey = mentionedPubkeys.find((pubkey) =>
            Array.from(projectCtx.agents.values()).some((agent) => agent.pubkey === pubkey)
        );

        if (targetAgentPubkey) {
            const delegationChain = buildDelegationChain(
                envelope,
                targetAgentPubkey,
                projectCtx.project.pubkey,
                conversation.id
            );

            if (delegationChain && delegationChain.length > 0) {
                conversation.updateMetadata({ delegationChain });
                await conversation.save();

                activeSpan?.addEvent("delegation_chain_built", {
                    "chain.length": delegationChain.length,
                    "chain.display": delegationChain.map((entry) => entry.displayName).join(" → "),
                });

                logger.debug("[ConversationResolver] Built delegation chain for new conversation", {
                    conversationId: conversation.id.substring(0, 8),
                    chainLength: delegationChain.length,
                    chain: delegationChain.map((entry) => entry.displayName).join(" → "),
                });
            }
        }

        logger.info(chalk.green(`Created new conversation ${conversation.id.substring(0, 8)} from kind:1 event`));
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

        const projectCtx = getProjectContext();
        const isDirectedToAgent = mentionedPubkeys.some((pubkey) =>
            Array.from(projectCtx.agents.values()).some((agent) => agent.pubkey === pubkey)
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
            logger.warn(chalk.yellow(`Could not fetch target event ${replyTargetId.substring(0, 8)} from network`));
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

        const referencedArticle = await extractReferencedArticle(rootEnvelope);
        if (referencedArticle) {
            conversation.updateMetadata({ referencedArticle });
            await conversation.save();

            activeSpan?.addEvent("referenced_article_loaded", {
                "article.title": referencedArticle.title,
                "article.dTag": referencedArticle.dTag,
                "article.content_length": referencedArticle.content.length,
            });
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
