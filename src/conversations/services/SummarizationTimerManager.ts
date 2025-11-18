import { config } from "@/services";
import { logger } from "@/utils/logger";
import { SUMMARIZATION_DEFAULTS } from "../constants";
import type { Conversation } from "../types";
import type { ConversationSummarizer } from "./ConversationSummarizer";

/**
 * Manages debounced timers for conversation summarization.
 * Single Responsibility: Handle timer scheduling and cleanup.
 */
export class SummarizationTimerManager {
    private timers = new Map<string, NodeJS.Timeout>();
    private timeoutMs: number = SUMMARIZATION_DEFAULTS.INACTIVITY_TIMEOUT_MS;

    constructor(private summarizer: ConversationSummarizer) {}

    /**
     * Initialize the timer manager and load configuration
     */
    async initialize(): Promise<void> {
        const { config: tenexConfig } = await config.loadConfig();
        this.timeoutMs =
            tenexConfig.summarization?.inactivityTimeout || SUMMARIZATION_DEFAULTS.INACTIVITY_TIMEOUT_MS;
        logger.info(`[SummarizationTimerManager] Initialized with ${this.timeoutMs}ms timeout`);
    }

    /**
     * Schedule or reschedule summarization for a conversation
     */
    scheduleSummarization(conversation: Conversation): void {
        // Clear existing timer if any
        this.clearTimer(conversation.id);

        // Set new timer
        const timer = setTimeout(async () => {
            logger.info(
                `[SummarizationTimerManager] Triggering summarization for conversation ${conversation.id}`
            );
            try {
                await this.summarizer.summarizeAndPublish(conversation);
            } catch (error) {
                logger.error(
                    `[SummarizationTimerManager] Failed to summarize conversation ${conversation.id}`,
                    { error }
                );
            } finally {
                this.timers.delete(conversation.id);
            }
        }, this.timeoutMs);

        this.timers.set(conversation.id, timer);
        logger.debug(
            `[SummarizationTimerManager] Scheduled summarization for conversation ${conversation.id}`
        );
    }

    /**
     * Clear timer for a specific conversation
     */
    clearTimer(conversationId: string): void {
        const existingTimer = this.timers.get(conversationId);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.timers.delete(conversationId);
            logger.debug(
                `[SummarizationTimerManager] Cleared timer for conversation ${conversationId}`
            );
        }
    }

    /**
     * Clear all timers
     */
    clearAllTimers(): void {
        for (const [conversationId, timer] of this.timers.entries()) {
            clearTimeout(timer);
            logger.debug(
                `[SummarizationTimerManager] Cleared timer for conversation ${conversationId}`
            );
        }
        this.timers.clear();
        logger.info("[SummarizationTimerManager] Cleared all timers");
    }

    /**
     * Get number of active timers
     */
    getActiveTimerCount(): number {
        return this.timers.size;
    }
}
