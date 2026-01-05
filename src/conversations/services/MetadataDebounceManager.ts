import { logger } from "@/utils/logger";

interface DebounceState {
    timerId: NodeJS.Timeout | null;
    firstExecutionDone: boolean;
    maxDeadline: number; // Unix timestamp (ms)
    pendingPublishFn: (() => Promise<void>) | null;
}

const DEBOUNCE_MS = 10_000; // 10 seconds
const MAX_DELAY_MS = 5 * 60_000; // 5 minutes

/**
 * Manages debounced publishing of kind 513 metadata events at conversation level.
 *
 * Strategy:
 * - First execution (or root event): publish immediately
 * - Subsequent executions: debounce by 10 seconds
 * - If another agent starts on same conversation: reset the debounce timer
 * - Max delay of 5 minutes before forcing publication
 */
class MetadataDebounceManager {
    private debounceStates = new Map<string, DebounceState>();

    /**
     * Called when an agent STARTS execution on a conversation.
     * Resets any pending debounce timer (but preserves the publish function).
     */
    onAgentStart(conversationId: string): void {
        const state = this.debounceStates.get(conversationId);
        if (state?.timerId) {
            clearTimeout(state.timerId);
            state.timerId = null;
            logger.debug("[MetadataDebounce] Timer reset on agent start", {
                conversationId: conversationId.substring(0, 8),
            });
        }
    }

    /**
     * Called when an agent COMPLETES execution.
     * Either publishes immediately (first exec or root event) or schedules debounced publish.
     */
    schedulePublish(
        conversationId: string,
        isRootEvent: boolean,
        publishFn: () => Promise<void>
    ): void {
        let state = this.debounceStates.get(conversationId);

        // First execution or root event: publish immediately
        if (!state || !state.firstExecutionDone || isRootEvent) {
            logger.debug("[MetadataDebounce] Publishing immediately (first/root)", {
                conversationId: conversationId.substring(0, 8),
                isRootEvent,
                isFirstExecution: !state?.firstExecutionDone,
            });

            // Initialize state
            if (!state) {
                state = {
                    timerId: null,
                    firstExecutionDone: true,
                    maxDeadline: Date.now() + MAX_DELAY_MS,
                    pendingPublishFn: null,
                };
                this.debounceStates.set(conversationId, state);
            } else {
                state.firstExecutionDone = true;
                state.maxDeadline = Date.now() + MAX_DELAY_MS;
            }

            // Publish immediately (fire and forget)
            publishFn().catch((error) => {
                logger.error("[MetadataDebounce] Failed to publish metadata", {
                    conversationId: conversationId.substring(0, 8),
                    error,
                });
            });
            return;
        }

        // Subsequent execution: debounce
        // Clear existing timer if any
        if (state.timerId) {
            clearTimeout(state.timerId);
            state.timerId = null;
        }

        // Update the pending publish function (use latest)
        state.pendingPublishFn = publishFn;

        const now = Date.now();

        // Check if we've exceeded max deadline
        if (now >= state.maxDeadline) {
            logger.debug("[MetadataDebounce] Max deadline reached, publishing now", {
                conversationId: conversationId.substring(0, 8),
            });

            // Reset deadline for next batch
            state.maxDeadline = now + MAX_DELAY_MS;

            publishFn().catch((error) => {
                logger.error("[MetadataDebounce] Failed to publish metadata", {
                    conversationId: conversationId.substring(0, 8),
                    error,
                });
            });
            return;
        }

        // Schedule debounced publish
        const delay = Math.min(DEBOUNCE_MS, state.maxDeadline - now);

        logger.debug("[MetadataDebounce] Scheduling debounced publish", {
            conversationId: conversationId.substring(0, 8),
            delayMs: delay,
        });

        state.timerId = setTimeout(() => {
            const currentState = this.debounceStates.get(conversationId);
            if (currentState?.pendingPublishFn) {
                // Reset deadline for next batch
                currentState.maxDeadline = Date.now() + MAX_DELAY_MS;
                currentState.timerId = null;

                currentState.pendingPublishFn().catch((error) => {
                    logger.error("[MetadataDebounce] Failed to publish metadata (debounced)", {
                        conversationId: conversationId.substring(0, 8),
                        error,
                    });
                });
                currentState.pendingPublishFn = null;
            }
        }, delay);
    }

    /**
     * Mark the first publish as done for a conversation.
     * This ensures subsequent schedulePublish calls will debounce instead of publishing immediately.
     * Use this when doing immediate metadata generation outside the debounce manager.
     */
    markFirstPublishDone(conversationId: string): void {
        let state = this.debounceStates.get(conversationId);
        if (!state) {
            state = {
                timerId: null,
                firstExecutionDone: true,
                maxDeadline: Date.now() + MAX_DELAY_MS,
                pendingPublishFn: null,
            };
            this.debounceStates.set(conversationId, state);
        } else {
            state.firstExecutionDone = true;
        }
        logger.debug("[MetadataDebounce] Marked first publish done", {
            conversationId: conversationId.substring(0, 8),
        });
    }

    /**
     * Cleanup for a specific conversation. Clears timer without publishing.
     */
    cleanup(conversationId: string): void {
        const state = this.debounceStates.get(conversationId);
        if (state?.timerId) {
            clearTimeout(state.timerId);
        }
        this.debounceStates.delete(conversationId);
    }

    /**
     * Cleanup all state. Called on shutdown.
     */
    cleanupAll(): void {
        for (const state of this.debounceStates.values()) {
            if (state.timerId) {
                clearTimeout(state.timerId);
            }
        }
        this.debounceStates.clear();
        logger.debug("[MetadataDebounce] All timers cleared on shutdown");
    }
}

// Singleton instance
export const metadataDebounceManager = new MetadataDebounceManager();
