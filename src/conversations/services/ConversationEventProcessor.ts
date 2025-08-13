import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKArticle } from "@nostr-dev-kit/ndk";
import type { Conversation, ConversationMetadata } from "../types";
import { PHASES } from "../phases";
import { isEventFromUser } from "@/nostr/utils";
import { getNDK } from "@/nostr";
import { logger } from "@/utils/logger";
import { ensureExecutionTimeInitialized } from "../executionTime";

/**
 * Processes events and creates/updates conversations.
 * Single Responsibility: Handle event processing and metadata extraction.
 */
export class ConversationEventProcessor {
    /**
     * Create a new conversation from an initial event
     */
    async createConversationFromEvent(event: NDKEvent): Promise<Conversation> {
        const id = event.id;
        if (!id) {
            throw new Error("Event must have an ID to create a conversation");
        }

        const title = event.tags.find(tag => tag[0] === "title")?.[1] || "Untitled Conversation";
        const referencedArticle = await this.extractReferencedArticle(event);

        const conversation: Conversation = {
            id,
            title,
            phase: PHASES.CHAT,
            history: [event],
            agentStates: new Map(),
            phaseStartedAt: Date.now(),
            metadata: {
                summary: event.content,
                referencedArticle
            },
            phaseTransitions: [],
            orchestratorTurns: [],
            executionTime: {
                totalSeconds: 0,
                isActive: false,
                lastUpdated: Date.now()
            }
        };

        ensureExecutionTimeInitialized(conversation);

        logger.info(`[ConversationEventProcessor] Created conversation ${id}`, {
            title,
            hasArticle: !!referencedArticle
        });

        return conversation;
    }

    /**
     * Process an incoming event and add it to a conversation
     */
    processIncomingEvent(conversation: Conversation, event: NDKEvent): void {
        // Add to history
        conversation.history.push(event);

        // Update metadata if it's a user message
        if (event.content && isEventFromUser(event)) {
            conversation.metadata.summary = event.content;
            conversation.metadata.last_user_message = event.content;
        }

        logger.debug(`[ConversationEventProcessor] Processed event for conversation ${conversation.id}`, {
            eventId: event.id,
            isUser: isEventFromUser(event)
        });
    }

    /**
     * Update conversation metadata
     */
    updateMetadata(conversation: Conversation, metadata: Partial<ConversationMetadata>): void {
        conversation.metadata = {
            ...conversation.metadata,
            ...metadata
        };

        logger.debug(`[ConversationEventProcessor] Updated metadata for conversation ${conversation.id}`, {
            updatedFields: Object.keys(metadata)
        });
    }

    /**
     * Extract referenced NDKArticle from event tags
     */
    private async extractReferencedArticle(event: NDKEvent): Promise<ConversationMetadata["referencedArticle"] | undefined> {
        const articleTag = event.tags.find(tag => tag[0] === "a" && tag[1]?.startsWith("30023:"));

        if (!articleTag || !articleTag[1]) {
            return undefined;
        }

        try {
            // Parse the article reference (format: 30023:pubkey:dtag)
            const [_kind, pubkey, dTag] = articleTag[1].split(":");

            if (!pubkey || !dTag) {
                return undefined;
            }

            const ndk = getNDK();
            const filter = {
                kinds: [30023],
                authors: [pubkey],
                "#d": [dTag]
            };

            const articles = await ndk.fetchEvents(filter);

            if (articles.size > 0) {
                const articleEvent = Array.from(articles)[0];
                if (!articleEvent) {
                    throw new Error("Article event not found");
                }
                const article = NDKArticle.from(articleEvent);

                return {
                    title: article.title || `Context: ${dTag}`,
                    content: article.content || "",
                    dTag: dTag
                };
            }
        } catch (error) {
            logger.error("[ConversationEventProcessor] Failed to fetch referenced NDKArticle", { error });
        }

        return undefined;
    }

    /**
     * Clean up conversation metadata that's no longer needed
     */
    cleanupMetadata(conversation: Conversation): void {
        // Clear readFiles tracking
        if (conversation.metadata.readFiles) {
            logger.info("[ConversationEventProcessor] Cleaning up readFiles metadata", {
                conversationId: conversation.id,
                fileCount: conversation.metadata.readFiles.length
            });
            delete conversation.metadata.readFiles;
        }

        // Clear queue status if present
        if (conversation.metadata.queueStatus) {
            delete conversation.metadata.queueStatus;
        }
    }

    /**
     * Extract completion from an event (if it's a complete() tool call)
     */
    extractCompletionFromEvent(event: NDKEvent): {
        agent: string;
        message: string;
        timestamp?: number;
    } | null {
        // Check if event has ["tool", "complete"] tag
        const isCompletion = event.tags?.some(
            tag => tag[0] === "tool" && tag[1] === "complete"
        );

        if (!isCompletion || !event.content) return null;

        const agentSlug = event.tags?.find(tag => tag[0] === "agent")?.[1];
        if (!agentSlug) return null;

        return {
            agent: agentSlug,
            message: event.content,
            timestamp: event.created_at
        };
    }
}