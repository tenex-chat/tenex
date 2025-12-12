import { config } from "@/services/ConfigService";
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
    private initialTimers = new Map<string, NodeJS.Timeout>();
    private initiallySummarizedConversations = new Set<string>();
    private isSummarizing = new Map<string, boolean>();
    private timeoutMs: number = SUMMARIZATION_DEFAULTS.INACTIVITY_TIMEOUT_MS;
    private initialDelayMs: number = SUMMARIZATION_DEFAULTS.INITIAL_SUMMARY_DELAY_MS;

    constructor(private summarizer: ConversationSummarizer) {}

    /**
     * Initialize the timer manager and load configuration
     */
    async initialize(): Promise<void> {
        const { config: tenexConfig } = await config.loadConfig();
        this.timeoutMs =
            tenexConfig.summarization?.inactivityTimeout || SUMMARIZATION_DEFAULTS.INACTIVITY_TIMEOUT_MS;
        this.initialDelayMs =
            tenexConfig.summarization?.initialDelay || SUMMARIZATION_DEFAULTS.INITIAL_SUMMARY_DELAY_MS;
        logger.info(`[SummarizationTimerManager] Initialized with ${this.timeoutMs}ms inactivity timeout and ${this.initialDelayMs}ms initial delay`);
    }

    /**
     * Schedule initial summarization for a new conversation (30 seconds after first message)
     */
    scheduleInitialSummarization(conversation: Conversation): void {
        // Don't schedule if already scheduled or already initially summarized
        if (this.initialTimers.has(conversation.id) || this.initiallySummarizedConversations.has(conversation.id)) {
            return;
        }

        this.scheduleTimer(
            conversation,
            "initial",
            this.initialDelayMs,
            () => {
                this.initiallySummarizedConversations.add(conversation.id);
            }
        );
    }

    /**
     * Schedule or reschedule summarization for a conversation (inactivity-based)
     */
    scheduleSummarization(conversation: Conversation): void {
        // Clear existing inactivity timer if any
        this.clearTimer(conversation.id);

        this.scheduleTimer(
            conversation,
            "inactivity",
            this.timeoutMs,
            undefined // No additional post-summarization action needed
        );
    }

    /**
     * Private helper method to schedule a timer with locking to prevent race conditions
     */
    private scheduleTimer(
        conversation: Conversation,
        timerType: "initial" | "inactivity",
        delayMs: number,
        postSummarizationAction?: () => void
    ): void {
        const timerMap = timerType === "initial" ? this.initialTimers : this.timers;
        const timerLabel = timerType === "initial" ? "initial" : "inactivity-based";

        const timer = setTimeout(async () => {
            // Check if already summarizing (prevent race conditions)
            if (this.isSummarizing.get(conversation.id)) {
                logger.debug(
                    `[SummarizationTimerManager] Skipping ${timerLabel} summarization for conversation ${conversation.id} - already in progress`
                );
                return;
            }

            logger.info(
                `[SummarizationTimerManager] Triggering ${timerLabel} summarization for conversation ${conversation.id}`
            );

            // Set lock
            this.isSummarizing.set(conversation.id, true);

            try {
                await this.summarizer.summarizeAndPublish(conversation);

                // Execute post-summarization action if provided
                if (postSummarizationAction) {
                    postSummarizationAction();
                }
            } catch (error) {
                logger.error(
                    `[SummarizationTimerManager] Failed to perform ${timerLabel} summarization for conversation ${conversation.id}`,
                    { error }
                );
            } finally {
                // Release lock and clean up timer
                this.isSummarizing.set(conversation.id, false);
                timerMap.delete(conversation.id);
            }
        }, delayMs);

        timerMap.set(conversation.id, timer);
        logger.debug(
            `[SummarizationTimerManager] Scheduled ${timerLabel} summarization for conversation ${conversation.id} in ${delayMs}ms`
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
                `[SummarizationTimerManager] Cleared inactivity timer for conversation ${conversationId}`
            );
        }
        this.timers.clear();

        for (const [conversationId, timer] of this.initialTimers.entries()) {
            clearTimeout(timer);
            logger.debug(
                `[SummarizationTimerManager] Cleared initial timer for conversation ${conversationId}`
            );
        }
        this.initialTimers.clear();

        logger.info("[SummarizationTimerManager] Cleared all timers");
    }

    /**
     * Get number of active timers
     */
    getActiveTimerCount(): number {
        return this.timers.size;
    }
}
