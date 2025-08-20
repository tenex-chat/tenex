import { logger } from "@/utils/logger";

export interface BufferedMessage {
  content: string;
  sessionId?: string;
  timestamp: number;
}

export interface DelayedMessageBufferOptions {
  delayMs?: number;
  onFlush: (message: BufferedMessage) => Promise<void>;
}

/**
 * Buffers messages with a delay to allow consuming them before publishing
 * Single Responsibility: Manage delayed message publishing with timeout
 */
export class DelayedMessageBuffer {
  private pendingMessage: BufferedMessage | null = null;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private readonly delayMs: number;
  private readonly onFlush: (message: BufferedMessage) => Promise<void>;

  constructor(options: DelayedMessageBufferOptions) {
    this.delayMs = options.delayMs ?? 500;
    this.onFlush = options.onFlush;
  }

  /**
   * Add a message to the buffer with automatic flush after delay
   */
  async buffer(content: string, sessionId?: string): Promise<void> {
    // Clear any existing timeout
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    // Store the new message
    this.pendingMessage = {
      content,
      sessionId,
      timestamp: Date.now(),
    };

    logger.debug("Buffered message for delayed publishing", {
      contentLength: content.length,
      sessionId,
      delayMs: this.delayMs,
    });

    // Set timeout to flush if not consumed
    this.timeoutHandle = setTimeout(() => {
      this.flush().catch((error) => {
        logger.error("Error flushing buffered message", { error });
      });
    }, this.delayMs);
  }

  /**
   * Consume the buffered message without publishing
   * Used when task completes within the delay window
   */
  consume(): BufferedMessage | null {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    const message = this.pendingMessage;
    this.pendingMessage = null;

    if (message) {
      logger.debug("Consumed buffered message", {
        contentLength: message.content.length,
        sessionId: message.sessionId,
        bufferedDuration: Date.now() - message.timestamp,
      });
    }

    return message;
  }

  /**
   * Flush the buffered message immediately
   * Called on timeout or explicit flush
   */
  async flush(): Promise<void> {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    const message = this.pendingMessage;
    this.pendingMessage = null;

    if (message) {
      logger.debug("Flushing buffered message", {
        contentLength: message.content.length,
        sessionId: message.sessionId,
        bufferedDuration: Date.now() - message.timestamp,
      });

      await this.onFlush(message);
    }
  }

  /**
   * Check if there's a pending message
   */
  hasPending(): boolean {
    return this.pendingMessage !== null;
  }

  /**
   * Clean up any pending timeouts
   */
  cleanup(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.pendingMessage = null;
  }
}
