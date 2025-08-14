import { logger } from "@/utils/logger";
import { type SDKMessage, query } from "@anthropic-ai/claude-code";
import type { ContentBlock, TextBlock } from "@anthropic-ai/sdk/resources/messages/messages";

export interface ClaudeCodeExecutorOptions {
    prompt: string;
    projectPath: string;
    systemPrompt?: string;
    timeout?: number;
    abortSignal?: AbortSignal;
    resumeSessionId?: string;
}

export interface ClaudeCodeResult {
    success: boolean;
    sessionId?: string;
    totalCost: number;
    messageCount: number;
    duration: number;
    assistantMessages: string[];
    error?: string;
}

/**
 * Low-level executor for Claude Code SDK
 * Single Responsibility: Execute Claude Code and stream raw SDK messages
 * Has NO knowledge of Nostr or tasks
 */
export class ClaudeCodeExecutor {
    private startTime: number;
    private abortController: AbortController;

    constructor(private options: ClaudeCodeExecutorOptions) {
        this.startTime = Date.now();
        this.abortController = new AbortController();

        // Link external abort signal if provided
        if (options.abortSignal) {
            options.abortSignal.addEventListener("abort", () => {
                this.abortController.abort(options.abortSignal?.reason);
            });
        }
    }

    /**
     * Execute Claude Code and stream SDK messages
     * @yields Raw SDKMessage events from the Claude Code SDK
     * @returns Final execution result with metrics
     */
    async *execute(): AsyncGenerator<SDKMessage, ClaudeCodeResult, unknown> {
        const metrics: {
            sessionId?: string;
            totalCost: number;
            messageCount: number;
            assistantMessages: string[];
        } = {
            totalCost: 0,
            messageCount: 0,
            assistantMessages: [],
        };

        try {
            // Set timeout if specified
            let timeoutId: NodeJS.Timeout | undefined;
            if (this.options.timeout) {
                timeoutId = setTimeout(() => {
                    this.abortController.abort(new Error("Timeout"));
                }, this.options.timeout);

                // Clear timeout if aborted early
                this.abortController.signal.addEventListener("abort", () => {
                    if (timeoutId) clearTimeout(timeoutId);
                });
            }

            // Log resume session ID if present
            if (this.options.resumeSessionId) {
                logger.info("[ClaudeCodeExecutor] Attempting to resume session", {
                    sessionId: this.options.resumeSessionId
                });
            }

            // Stream messages from Claude Code SDK
            for await (const message of query({
              prompt: this.options.prompt,
              options: {
                cwd: this.options.projectPath,
                permissionMode: "bypassPermissions",
                appendSystemPrompt: this.options.systemPrompt,
                resume: this.options.resumeSessionId,
              },
            })) {
              // Extract metrics from messages
              if (!metrics.sessionId && message.session_id) {
                metrics.sessionId = message.session_id;
              }

              if (message.type === "assistant") {
                metrics.messageCount++;
                const content = this.extractTextContent(message);
                if (content) {
                  metrics.assistantMessages.push(content);
                }
              }

              if (message.type === "result" && "total_cost_usd" in message) {
                metrics.totalCost = message.total_cost_usd;
              }

              // Yield the message to the caller
              yield message;
            }

            // Clear timeout on success
            if (timeoutId) clearTimeout(timeoutId);

            const duration = Date.now() - this.startTime;
            return {
                success: true,
                sessionId: metrics.sessionId,
                totalCost: metrics.totalCost,
                messageCount: metrics.messageCount,
                duration,
                assistantMessages: metrics.assistantMessages,
            };
        } catch (err) {
            const duration = Date.now() - this.startTime;
            const error = err instanceof Error ? err.message : "Unknown error";

            logger.error("[ClaudeCodeExecutor] Execution failed", { error, duration });

            return {
                success: false,
                sessionId: metrics.sessionId,
                totalCost: metrics.totalCost,
                messageCount: metrics.messageCount,
                duration,
                assistantMessages: metrics.assistantMessages,
                error,
            };
        }
    }

    /**
     * Extract text content from an assistant message
     */
    private extractTextContent(message: SDKMessage): string {
        if (message.type !== "assistant" || !message.message?.content) {
            return "";
        }

        return message.message.content
            .filter((c: ContentBlock): c is TextBlock => c.type === "text")
            .map((c: TextBlock) => c.text)
            .join("");
    }

    kill(): void {
        this.abortController.abort();
    }

    isRunning(): boolean {
        return !this.abortController.signal.aborted;
    }
}
