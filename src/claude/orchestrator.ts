import type { ConversationCoordinator } from "@/conversations/ConversationCoordinator";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { PHASES } from "@/conversations/phases";
import type { Conversation } from "@/conversations/types";
import type { TaskPublisher } from "@/nostr/TaskPublisher";
import { getNDK } from "@/nostr/ndkClient";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import type { ContentBlock, TextBlock } from "@anthropic-ai/sdk/resources/messages/messages";
import type { NDKEvent, NDKSubscription, NDKTask } from "@nostr-dev-kit/ndk";
import { DelayedMessageBuffer } from "./DelayedMessageBuffer";
import { ClaudeCodeExecutor } from "./executor";

export interface ClaudeTaskOptions {
  prompt: string;
  systemPrompt?: string;
  projectPath: string;
  title: string;
  branch?: string;
  conversationRootEventId?: string;
  conversation?: Conversation;
  conversationCoordinator?: ConversationCoordinator;
  abortSignal?: AbortSignal;
  resumeSessionId?: string;
  agentName?: string;
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

    // Create task with conversation mapping and delegation context
    const task = await this.taskPublisher.createTask({
      title: options.title,
      prompt: options.prompt,
      branch: options.branch,
      conversationRootEventId: options.conversationRootEventId,
      conversationCoordinator: options.conversationCoordinator,
      claudeSessionId: options.resumeSessionId,
      // Provide delegation context for Claude Code tasks so they get registered
      delegationContext: options.conversation ? {
        conversationId: options.conversation.id,
        originalRequest: options.prompt,
        phase: PHASES.EXECUTE, // Claude Code tasks are always in execution phase
      } : undefined,
    });

    // Log if we're resuming a session
    if (options.resumeSessionId) {
      logger.info("[ClaudeTaskOrchestrator] Creating executor with resumeSessionId", {
        resumeSessionId: options.resumeSessionId,
      });
    }

    // Create message buffer for delayed publishing
    const messageBuffer = new DelayedMessageBuffer({
      delayMs: 500, // Configurable delay
      onFlush: async (message) => {
        // Publish as progress when timeout expires
        await this.taskPublisher.publishTaskProgress(message.content, message.sessionId);
      },
    });

    // Create executor
    const executor = new ClaudeCodeExecutor({
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      projectPath: options.projectPath,
      abortSignal: options.abortSignal,
      resumeSessionId: options.resumeSessionId,
      agentName: options.agentName,
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

        // Flush any pending message before interrupting
        await messageBuffer.flush();

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
      let lastAssistantMessage = "";
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

          // Consume buffered message if available
          const bufferedMessage = messageBuffer.consume();
          const finalMessage = bufferedMessage?.content || lastAssistantMessage;

          // Complete task with the final message
          await this.taskPublisher.completeTask(executionResult.success, {
            sessionId: executionResult.sessionId,
            totalCost: executionResult.totalCost,
            messageCount: executionResult.messageCount,
            duration: executionResult.duration,
            error: executionResult.error,
            finalMessage: executionResult.success ? finalMessage : undefined,
          });

          result = {
            task,
            sessionId: executionResult.sessionId,
            totalCost: executionResult.totalCost,
            messageCount: executionResult.messageCount,
            duration: executionResult.duration,
            success: executionResult.success,
            error: executionResult.error,
            finalResponse: finalMessage,
          };
          break;
        }

        // Capture session ID when it becomes available
        if (message?.session_id && !sessionId) {
          sessionId = message.session_id;
          logger.debug("Captured Claude session ID", { sessionId });
        }

        // Process SDK message and buffer progress updates
        if (message && message.type === "assistant" && message.message?.content) {
          const textContent = message.message.content
            .filter((c: ContentBlock): c is TextBlock => c.type === "text")
            .map((c: TextBlock) => c.text)
            .join("");

          if (textContent) {
            lastAssistantMessage = textContent;

            // Buffer the message instead of publishing immediately
            await messageBuffer.buffer(textContent, sessionId);
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

      // Clean up message buffer
      messageBuffer.cleanup();

      const errorMessage = formatAnyError(error);

      // Check if this was an abort
      const isAborted = errorMessage.includes("aborted") || errorMessage.includes("interrupted");

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
      // Clean up resources
      messageBuffer.cleanup();

      // Clean up abort subscription
      if (abortSubscription) {
        abortSubscription.stop();
      }
    }
  }
}
