import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import type { Conversation } from "@/conversations/types";
import type { ConversationManager } from "@/conversations/ConversationManager";
import type { TaskPublisher } from "@/nostr/TaskPublisher";
import { logger } from "@/utils/logger";
import { formatAnyError } from "@/utils/error-formatter";
import type { ContentBlock, TextBlock } from "@anthropic-ai/sdk/resources/messages/messages";
import type { NDKTask, NDKEvent, NDKSubscription } from "@nostr-dev-kit/ndk";
import { ClaudeCodeExecutor } from "./executor";
import { getNDK } from "@/nostr/ndkClient";

export interface ClaudeTaskOptions {
    prompt: string;
    systemPrompt?: string;
    projectPath: string;
    title: string;
    branch?: string;
    conversationRootEventId?: string;
    conversation?: Conversation;
    conversationManager?: ConversationManager;
    abortSignal?: AbortSignal;
    resumeSessionId?: string;
}

export interface ClaudeTaskResult {
    task: NDKTask;
    sessionId?: string;
    totalCost: number;
    messageCount: number;
    duration: number;
    success: boolean;
    error?: string;
    finalResponse?: string;
}

/**
 * Orchestrates Claude Code execution with Nostr task tracking
 * Single Responsibility: Coordinate Claude SDK execution with task lifecycle and Nostr publishing
 */
export class ClaudeTaskOrchestrator {
    constructor(private taskPublisher: TaskPublisher) {}

    async execute(options: ClaudeTaskOptions): Promise<ClaudeTaskResult> {
        const startTime = Date.now();

        // Create task with conversation mapping
        const task = await this.taskPublisher.createTask({
            title: options.title,
            prompt: options.prompt,
            branch: options.branch,
            conversationRootEventId: options.conversationRootEventId,
            conversationManager: options.conversationManager,
            claudeSessionId: options.resumeSessionId,
        });

        // Log if we're resuming a session
        if (options.resumeSessionId) {
            logger.info("[ClaudeTaskOrchestrator] Creating executor with resumeSessionId", {
                resumeSessionId: options.resumeSessionId
            });
        }

        // Create executor
        const executor = new ClaudeCodeExecutor({
            prompt: options.prompt,
            systemPrompt: options.systemPrompt,
            projectPath: options.projectPath,
            abortSignal: options.abortSignal,
            resumeSessionId: options.resumeSessionId,
        });

        // Set up abort event subscription
        let abortSubscription: NDKSubscription | undefined;
        const ndk = getNDK();

        if (ndk) {
            // Subscribe to ephemeral abort events targeting this task
            abortSubscription = ndk.subscribe(
                {
                    kinds: [24133], // Ephemeral event for task abort
                    "#e": [task.id], // Events e-tagging this task
                },
                {
                    closeOnEose: false,
                    groupable: false,
                }
            );

            abortSubscription.on("event", async (_event: NDKEvent) => {
                logger.info("Received abort request for task", { taskId: task.id });

                // Abort the executor
                executor.kill();

                // Update task status to interrupted
                await this.taskPublisher.publishTaskProgress("Task interrupted by user request");
            });
        }

        try {
            // Start execution timing
            if (options.conversation) {
                startExecutionTime(options.conversation);
            }

            // Track the last assistant message for final response
            let lastAssistantMessage: string = "";
            let sessionId: string | undefined;

            // Execute and stream messages
            const generator = executor.execute();
            let result: ClaudeTaskResult | undefined;

            while (true) {
                const { value: message, done } = await generator.next();
                logger.debug("Claude Orc", { message, done });

                if (done) {
                    // The value is the final ClaudeCodeResult
                    const executionResult = message;

                    // Stop timing
                    if (options.conversation) {
                        stopExecutionTime(options.conversation);
                    }

                    // Complete task
                    await this.taskPublisher.completeTask(executionResult.success, {
                        sessionId: executionResult.sessionId,
                        totalCost: executionResult.totalCost,
                        messageCount: executionResult.messageCount,
                        duration: executionResult.duration,
                        error: executionResult.error,
                    });

                    result = {
                        task,
                        sessionId: executionResult.sessionId,
                        totalCost: executionResult.totalCost,
                        messageCount: executionResult.messageCount,
                        duration: executionResult.duration,
                        success: executionResult.success,
                        error: executionResult.error,
                        finalResponse: lastAssistantMessage,
                    };
                    break;
                }

                // Capture session ID when it becomes available
                if (message && message.session_id && !sessionId) {
                    sessionId = message.session_id;
                    logger.debug("Captured Claude session ID", { sessionId });
                }

                // Process SDK message and publish progress updates
                if (message && message.type === "assistant" && message.message?.content) {
                    const textContent = message.message.content
                        .filter((c: ContentBlock): c is TextBlock => c.type === "text")
                        .map((c: TextBlock) => c.text)
                        .join("");

                    if (textContent) {
                        lastAssistantMessage = textContent;

                        // Publish progress update using TaskPublisher with session ID
                        await this.taskPublisher.publishTaskProgress(textContent, sessionId);
                    }
                }
            }

            if (!result) {
                throw new Error("No result returned from ClaudeCodeExecutor");
            }
            return result;
        } catch (error) {
            // Stop timing on error
            if (options.conversation) {
                stopExecutionTime(options.conversation);
            }

            const errorMessage = formatAnyError(error);

            // Check if this was an abort
            const isAborted =
                errorMessage.includes("aborted") || errorMessage.includes("interrupted");

            // Mark task as failed or interrupted
            if (isAborted) {
                await this.taskPublisher.completeTask(false, { error: "Task interrupted by user" });
            } else {
                await this.taskPublisher.completeTask(false, { error: errorMessage });
            }

            logger.error("Claude task execution failed", { error: errorMessage, isAborted });

            return {
                task,
                totalCost: 0,
                messageCount: 0,
                duration: Date.now() - startTime,
                success: false,
                error: errorMessage,
            };
        } finally {
            // Clean up abort subscription
            if (abortSubscription) {
                abortSubscription.stop();
            }
        }
    }
}
