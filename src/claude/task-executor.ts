import type { ConversationCoordinator } from "@/conversations";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import type { Conversation } from "@/conversations/types";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import type { EventContext } from "@/nostr/AgentEventEncoder";
import { getNDK } from "@/nostr/ndkClient";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import type { ContentBlock, TextBlock, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages/messages";
import type { NDKEvent, NDKSubscription, NDKTask } from "@nostr-dev-kit/ndk";
import { ClaudeCodeExecutor } from "./executor";

export interface ClaudeTaskOptions {
  prompt: string;
  systemPrompt?: string;
  projectPath: string;
  title: string;
  branch?: string;
  conversationRootEventId: string;
  conversation?: Conversation;
  conversationCoordinator: ConversationCoordinator;
  abortSignal?: AbortSignal;
  claudeSessionId: string;
  resumeSessionId?: string; // Only set when actually resuming an existing session
  agentName: string;
  triggeringEvent: NDKEvent;
}

export interface ClaudeTaskResult {
  taskEvent: NDKTask;
  sessionId?: string;
  totalCost: number;
  messageCount: number;
  duration: number;
  success: boolean;
  error?: string;
  finalResponse?: string;
}

/**
 * Executes Claude Code tasks with Nostr event publishing
 * Single Responsibility: Coordinate Claude SDK execution with event lifecycle and Nostr publishing
 */
export class ClaudeTaskExecutor {
  constructor(private agentPublisher: AgentPublisher) {}

  async execute(options: ClaudeTaskOptions): Promise<ClaudeTaskResult> {
    const startTime = Date.now();

    // Create base event context for task creation and updates
    // Use the conversation's first event as root, or fall back to the triggering event
    const rootEvent = options.conversation?.history[0] ?? options.triggeringEvent;
    const baseEventContext: EventContext = {
      triggeringEvent: options.triggeringEvent,
      rootEvent: rootEvent,
      conversationId: options.conversationRootEventId,
    };

    // Create task through AgentPublisher with full context
    const task = await this.agentPublisher.createTask(
      options.title,
      options.prompt,
      baseEventContext,
      options.claudeSessionId,
      options.branch
    );

    logger.info("[ClaudeTaskExecutor] Created task", {
      taskId: task.id,
      sessionId: options.claudeSessionId,
      title: options.title,
    });

    // Create executor
    const executor = new ClaudeCodeExecutor({
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      projectPath: options.projectPath,
      abortSignal: options.abortSignal,
      resumeSessionId: options.resumeSessionId, // Use the explicit resume parameter
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

        // Publish task update for interruption
        await this.agentPublisher.publishTaskUpdate(
          task,
          "Task interrupted by user request",
          baseEventContext
        );
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
        logger.info("Claude Executor", { message, done });

        if (done) {
          // The value is the final ClaudeCodeResult
          const executionResult = message;

          // Stop timing
          if (options.conversation) {
            stopExecutionTime(options.conversation);
          }

          const finalMessage = lastAssistantMessage || "Task completed";

          result = {
            taskEvent: task,
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

        // Process SDK message and publish progress updates immediately
        if (message && message.type === "assistant" && message.message?.content) {
          // Handle text content
          const textContent = message.message.content
            .filter((c: ContentBlock): c is TextBlock => c.type === "text")
            .map((c: TextBlock) => c.text)
            .join("");

          if (textContent) {
            lastAssistantMessage = textContent;

            // Publish progress update immediately
            await this.agentPublisher.publishTaskUpdate(
              task,
              textContent,
              baseEventContext
            );
          }

          // Handle tool use content (like TodoWrite)
          const toolUseBlocks = message.message.content
            .filter((c: ContentBlock): c is ToolUseBlock => c.type === "tool_use");

          for (const toolBlock of toolUseBlocks) {
            let toolMessage: string | undefined;
            
            // Special formatting for TodoWrite tool
            if (toolBlock.name === "TodoWrite" && toolBlock.input?.todos) {
              const todos = toolBlock.input.todos as Array<{
                content: string;
                status: "pending" | "in_progress" | "completed";
                activeForm?: string;
              }>;
              
              const todoLines = todos.map(todo => {
                let emoji = "☑️"; // pending
                if (todo.status === "in_progress") {
                  emoji = "➡️";
                } else if (todo.status === "completed") {
                  emoji = "✅";
                }
                // Use activeForm if in_progress, otherwise use content
                const text = todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content;
                return `${emoji} ${text}`;
              });
              
              toolMessage = todoLines.join("\n");
            }
            
            // Only publish if we have content
            if (toolMessage) {
              await this.agentPublisher.publishTaskUpdate(
                task,
                toolMessage,
                baseEventContext
              );

              logger.debug("Published tool use to Nostr", {
                tool: toolBlock.name,
                id: toolBlock.id,
                taskId: task.id,
              });
            }
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
      const isAborted = errorMessage.includes("aborted") || errorMessage.includes("interrupted");

      // Publish error task update
      await this.agentPublisher.publishTaskUpdate(
        task,
        `❌ Task ${isAborted ? 'interrupted' : 'failed'}\n\nError: ${errorMessage}`,
        baseEventContext
      );

      logger.error("Claude task execution failed", { error: errorMessage, isAborted });

      return {
        taskEvent: task,
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
