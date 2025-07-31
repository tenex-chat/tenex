import { logger } from "@/utils/logger";
import type { NostrPublisher } from "./NostrPublisher";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Manages typing indicator state to prevent flickering and ensure minimum duration.
 * 
 * Key features:
 * - Ensures typing indicators remain visible for at least 5 seconds
 * - Prevents flickering when multiple messages are sent rapidly
 * - Debounces stop events to batch rapid changes
 */
export class TypingIndicatorManager {
    private static readonly MINIMUM_DURATION_MS = 5000; // 5 seconds
    private static readonly DEBOUNCE_DELAY_MS = 200; // 200ms debounce for rapid messages
    
    private typingStartTime: number | null = null;
    private stopTimer: NodeJS.Timeout | null = null;
    private isTyping = false;
    private lastMessage: string | undefined;
    private publisher: NostrPublisher;
    
    constructor(publisher: NostrPublisher) {
        this.publisher = publisher;
    }
    
    /**
     * Start or update the typing indicator.
     * If already typing, this will update the message and reset the timer.
     */
    async start(message?: string): Promise<NDKEvent> {
        // Clear any pending stop timer
        if (this.stopTimer) {
            clearTimeout(this.stopTimer);
            this.stopTimer = null;
        }
        
        // If not currently typing, record start time
        if (!this.isTyping) {
            this.typingStartTime = Date.now();
            this.isTyping = true;
        }
        
        // Update the message if provided
        if (message !== undefined) {
            this.lastMessage = message;
        }
        
        logger.debug("Starting/updating typing indicator", {
            agent: this.publisher.context.agent.name,
            message: this.lastMessage,
            isNewTyping: this.typingStartTime === Date.now(),
        });
        
        // Publish the typing indicator using the raw method to bypass timing logic
        // Type assertion needed as publishTypingIndicatorRaw is an internal method
        const publisher = this.publisher as NostrPublisher & {
            publishTypingIndicatorRaw(state: "start" | "stop", message?: string): Promise<NDKEvent>;
        };
        return await publisher.publishTypingIndicatorRaw("start", this.lastMessage);
    }
    
    /**
     * Request to stop the typing indicator.
     * This will be delayed to ensure minimum duration is met.
     */
    async stop(): Promise<void> {
        if (!this.isTyping) {
            return; // Already stopped
        }
        
        // Clear any existing stop timer
        if (this.stopTimer) {
            clearTimeout(this.stopTimer);
            this.stopTimer = null;
        }
        
        // Calculate how long we've been typing
        const typingDuration = this.typingStartTime ? Date.now() - this.typingStartTime : 0;
        const remainingTime = Math.max(0, TypingIndicatorManager.MINIMUM_DURATION_MS - typingDuration);
        
        logger.debug("Stop typing indicator requested", {
            agent: this.publisher.context.agent.name,
            typingDuration,
            remainingTime,
            willDelay: remainingTime > 0,
        });
        
        // Schedule the actual stop
        this.stopTimer = setTimeout(async () => {
            try {
                const publisher = this.publisher as NostrPublisher & {
                    publishTypingIndicatorRaw(state: "start" | "stop", message?: string): Promise<NDKEvent>;
                };
                await publisher.publishTypingIndicatorRaw("stop");
                this.isTyping = false;
                this.typingStartTime = null;
                this.lastMessage = undefined;
                this.stopTimer = null;
                
                logger.debug("Typing indicator stopped", {
                    agent: this.publisher.context.agent.name,
                });
            } catch (error) {
                logger.error("Failed to stop typing indicator", {
                    agent: this.publisher.context.agent.name,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }, remainingTime);
    }
    
    /**
     * Force immediate stop, bypassing minimum duration.
     * Use this only when necessary (e.g., on error or shutdown).
     */
    async forceStop(): Promise<void> {
        // Clear any pending stop timer
        if (this.stopTimer) {
            clearTimeout(this.stopTimer);
            this.stopTimer = null;
        }
        
        if (this.isTyping) {
            try {
                const publisher = this.publisher as NostrPublisher & {
                    publishTypingIndicatorRaw(state: "start" | "stop", message?: string): Promise<NDKEvent>;
                };
                await publisher.publishTypingIndicatorRaw("stop");
                this.isTyping = false;
                this.typingStartTime = null;
                this.lastMessage = undefined;
                
                logger.debug("Typing indicator force stopped", {
                    agent: this.publisher.context.agent.name,
                });
            } catch (error) {
                logger.error("Failed to force stop typing indicator", {
                    agent: this.publisher.context.agent.name,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    
    /**
     * Check if currently typing.
     */
    isCurrentlyTyping(): boolean {
        return this.isTyping;
    }
    
    /**
     * Clean up any pending timers.
     */
    cleanup(): void {
        if (this.stopTimer) {
            clearTimeout(this.stopTimer);
            this.stopTimer = null;
        }
    }
}