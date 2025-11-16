import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { type Span, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("tenex.conversation");

/**
 * Manages conversation-level metadata for tracing.
 *
 * Instead of long-lived parent spans, this tracks conversation message counts
 * and adds conversation.id attributes to all spans. This allows querying Jaeger
 * for all traces with the same conversation.id to see the full timeline.
 *
 * Benefits:
 * - No long-lived spans (avoids OTEL issues with spans that never end)
 * - Immediate visibility in Jaeger (spans export as soon as they complete)
 * - Easy querying: Search for conversation.id tag in Jaeger
 */
export class ConversationSpanManager {
    private conversationMessageCounts = new Map<string, number>();
    private cleanupInterval: NodeJS.Timeout | null = null;

    // Configuration
    private readonly MAX_CONVERSATION_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
    private readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

    constructor() {
        this.startCleanupTimer();
    }

    /**
     * Increment message count for a conversation and add to span attributes
     */
    incrementMessageCount(conversationId: string, span: Span): void {
        const currentCount = (this.conversationMessageCounts.get(conversationId) || 0) + 1;
        this.conversationMessageCounts.set(conversationId, currentCount);

        span.setAttributes({
            "conversation.message_sequence": currentCount,
        });

        logger.debug("Incremented conversation message count", {
            conversationId: conversationId.substring(0, 8),
            messageSequence: currentCount,
        });
    }

    /**
     * Get total message count for a conversation
     */
    getMessageCount(conversationId: string): number {
        return this.conversationMessageCounts.get(conversationId) || 0;
    }

    /**
     * Start automatic cleanup timer (not used in this implementation but kept for future)
     */
    private startCleanupTimer(): void {
        // Cleanup not needed with attribute-based approach
        // Message counts are lightweight and don't need cleanup
    }

    /**
     * Shutdown (no-op for this implementation)
     */
    shutdown(): void {
        logger.info("Shutting down ConversationSpanManager", {
            trackedConversations: this.conversationMessageCounts.size,
        });
        this.conversationMessageCounts.clear();
    }

    /**
     * Get stats about tracked conversations
     */
    getStats(): {
        trackedConversations: number;
        totalMessages: number;
    } {
        let totalMessages = 0;

        for (const count of this.conversationMessageCounts.values()) {
            totalMessages += count;
        }

        return {
            trackedConversations: this.conversationMessageCounts.size,
            totalMessages,
        };
    }
}

// Singleton instance
let conversationSpanManager: ConversationSpanManager | null = null;

/**
 * Get or create the conversation span manager instance
 */
export function getConversationSpanManager(): ConversationSpanManager {
    if (!conversationSpanManager) {
        conversationSpanManager = new ConversationSpanManager();
    }
    return conversationSpanManager;
}

/**
 * Reset the conversation span manager (for testing)
 */
export function resetConversationSpanManager(): void {
    if (conversationSpanManager) {
        conversationSpanManager.shutdown();
    }
    conversationSpanManager = null;
}
