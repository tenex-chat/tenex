import { MessageBuilder } from "@/conversations/MessageBuilder";
import { PHASES } from "@/conversations/phases";
import type { LLMService, StreamEvent, Tool } from "@/llm/types";
import { type ContextualLogger, createExecutionLogger } from "@/logging/UnifiedLogger";
import type { CompletionIntent, EventContext } from "@/nostr/AgentEventEncoder";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { buildLLMMetadata } from "@/prompts/utils/llmMetadata";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import type { ToolExecutionResult } from "@/tools/executor";
import type { TracingContext, TracingLogger } from "@/tracing";
import { createTracingContext, createTracingLogger } from "@/tracing";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { Message } from "multi-llm-ts";
import { StreamStateManager } from "./StreamStateManager";
import { ToolRepetitionDetector } from "./ToolRepetitionDetector";
import { ToolStreamHandler } from "./ToolStreamHandler";
import type { ExecutionContext } from "./types";

// Maximum iterations to prevent infinite loops
const MAX_ITERATIONS = 20;

/**
 * ReasonActLoop implementation that properly implements the Reason-Act-Observe pattern.
 * Iteratively calls the LLM, executes tools, and feeds results back for further reasoning.
 */
export class ReasonActLoop {
  private executionLogger?: ContextualLogger;
  private repetitionDetector: ToolRepetitionDetector;
  private messageBuilder: MessageBuilder;
  private startTime?: number;
  private agentPublisher!: AgentPublisher;

  constructor(private llmService: LLMService) {
    this.repetitionDetector = new ToolRepetitionDetector();
    this.messageBuilder = new MessageBuilder();
    // AgentPublisher and AgentStreamer will be initialized in execute() when we have the agent
  }

  /**
   * Core execution implementation for all agents
   */
  async execute(messages: Array<Message>, tools: Tool[], context: ExecutionContext): Promise<void> {
    this.startTime = Date.now();
    const tracingContext = createTracingContext(context.conversationId);
    this.executionLogger = createExecutionLogger(tracingContext, "agent");

    // Use the shared AgentPublisher from context
    this.agentPublisher = context.agentPublisher;

    // Execute the streaming loop
    const generator = this.executeStreamingInternal(context, messages, tracingContext, tools);

    // Drain the generator
    let iterResult: IteratorResult<StreamEvent, void>;
    do {
      iterResult = await generator.next();
    } while (!iterResult.done);
  }

  async *executeStreamingInternal(
    context: ExecutionContext,
    messages: Message[],
    tracingContext: TracingContext,
    tools?: Tool[]
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const tracingLogger = createTracingLogger(tracingContext, "agent");

    // Initialize handlers
    const stateManager = new StreamStateManager();
    const toolHandler = new ToolStreamHandler(stateManager, this.agentPublisher, this.executionLogger);

    this.logExecutionStart(tracingLogger, context, tools);

    // Track conversation messages for the iterative loop
    const conversationMessages = [...messages];
    let iterations = 0;
    let shouldContinueLoop = true;

    // Build event context for streaming
    const conversation = context.conversationCoordinator.getConversation(context.conversationId);
    const eventContext: EventContext = {
      triggeringEvent: context.triggeringEvent,
      rootEvent: conversation?.history[0] ?? context.triggeringEvent,
      conversationId: context.conversationId,
      phase: context.phase,
    };

    try {
      // Main Reason-Act-Observe loop
      while (shouldContinueLoop && iterations < MAX_ITERATIONS) {
        iterations++;
        tracingLogger.info("[ReasonActLoop] Starting iteration", {
          iteration: iterations,
          shouldContinueLoop,
          messageCount: conversationMessages.length,
          lastMessage: conversationMessages[conversationMessages.length - 1].content.substring(
            0,
            100
          ),
        });

        // Create stream with streamHandle in context
        const stream = this.createLLMStream(context, conversationMessages, tools);

        // Process stream events for this iteration
        const iterationResult = await this.processIterationStream(
          stream,
          stateManager,
          toolHandler,
          eventContext,
          tracingLogger,
          context,
          conversationMessages
        );

        // Yield events from this iteration
        for (const event of iterationResult.events) {
          yield event;
        }

        // Check if we should continue iterating
        if (iterationResult.hasToolCalls) {
          // Add tool results to conversation for next iteration
          this.addToolResultsToConversation(
            conversationMessages,
            iterationResult.toolResults,
            iterationResult.assistantMessage,
            tracingLogger
          );
        } else if (this.agentPublisher.hasBufferedContent()) {
          // Agent generated content but no tool calls or terminal tool
          // This means the agent has provided a textual response - we should complete
          const bufferedContent = this.agentPublisher.getBufferedContent();
          conversationMessages.push(new Message("assistant", bufferedContent));
          tracingLogger.info("[ReasonActLoop] Agent generated content, completing", {
            iteration: iterations,
            contentLength: bufferedContent.length,
          });
          shouldContinueLoop = false; // Complete after generating a response
        } else {
          // No tool calls, no terminal tool, AND no content was generated
          // This indicates the agent truly has nothing further to do
          tracingLogger.info("[ReasonActLoop] No tool calls, no content, ending loop", {
            iteration: iterations,
          });
          shouldContinueLoop = false;
        }

        // Stream finalization is no longer needed here
        // The streaming buffer is only for kind:21111 events
        // Final kind:1111 events come from StreamStateManager.fullContent via implicit/explicit completion
      }

      tracingLogger.info("[ReasonActLoop] Exited main loop", {
        iterations,
        shouldContinueLoop,
        reason: !shouldContinueLoop ? "completed" : "max iterations",
      });

      if (iterations >= MAX_ITERATIONS && shouldContinueLoop) {
        const error = new Error(
          `Agent ${context.agent.name} reached maximum iterations (${MAX_ITERATIONS}) without completing task`
        );
        tracingLogger.error("[ReasonActLoop] Maximum iterations reached without completion", {
          maxIterations: MAX_ITERATIONS,
          agent: context.agent.name,
          phase: context.phase,
        });
        throw error;
      }

      // Handle natural completion for ALL phases
      const fullContent = this.agentPublisher.getBufferedContent();
      this.agentPublisher.clearBuffer();
      
      if (fullContent.trim().length > 0) {
        // Build event context with all metadata
        const conversation = context.conversationCoordinator.getConversation(context.conversationId);
        const eventContext: EventContext = {
          triggeringEvent: context.triggeringEvent,
          rootEvent: conversation?.history[0] ?? context.triggeringEvent,
          conversationId: context.conversationId,
        };

        // Get LLM metadata for the completion event
        const finalResponse = stateManager.getFinalResponse();
        if (finalResponse) {
          const llmMetadata = await buildLLMMetadata(finalResponse, conversationMessages);
          if (llmMetadata) {
            eventContext.model = llmMetadata.model;
            eventContext.cost = llmMetadata.cost;
            eventContext.usage = {
              prompt_tokens: llmMetadata.promptTokens,
              completion_tokens: llmMetadata.completionTokens,
              total_tokens: llmMetadata.totalTokens,
            };
          }
        }

        // Tools publish their own events now, no need to track them here
        eventContext.executionTime = this.startTime ? Date.now() - this.startTime : undefined;
        eventContext.phase = context.phase;

        const naturalCompletionIntent: CompletionIntent = {
          type: 'completion',
          content: fullContent,
        };

        await this.agentPublisher.complete(naturalCompletionIntent, eventContext);
        
        tracingLogger.info("[ReasonActLoop] Published natural completion", {
          agent: context.agent.name,
          phase: context.phase,
          contentLength: fullContent.length,
        });
      }

      yield this.createFinalEvent(stateManager);
    } catch (error) {
      yield* this.handleError(error, tracingLogger, context);
      throw error;
    }
  }

  /**
   * Process a single iteration of the stream and collect results
   */
  private async processIterationStream(
    stream: AsyncIterable<StreamEvent>,
    stateManager: StreamStateManager,
    toolHandler: ToolStreamHandler,
    eventContext: EventContext,
    tracingLogger: TracingLogger,
    context: ExecutionContext,
    messages: Message[]
  ): Promise<{
    events: StreamEvent[];
    hasToolCalls: boolean;
    toolResults: ToolExecutionResult[];
    assistantMessage: string;
  }> {
    const events: StreamEvent[] = [];
    let hasToolCalls = false;
    const toolResults: ToolExecutionResult[] = [];
    let assistantMessage = "";

    for await (const event of stream) {
      tracingLogger.info("[processIterationStream]", {
        agent: context.agent.name,
        type: event.type,
        content: event.content
      });
      events.push(event);

      switch (event.type) {
        case "content":
          await this.handleContentEvent(event, stateManager, eventContext, context);
          // Buffer content instead of streaming immediately
          // We'll decide whether to output it after processing all events
          assistantMessage += event.content;
          break;

        case "tool_start": {
          hasToolCalls = true;

          // Check for repetitive tool calls
          const warningMessage = this.repetitionDetector.checkRepetition(event.tool, event.args);
          if (warningMessage) {
            const systemMessage = this.messageBuilder.formatSystemMessage(
              warningMessage,
              "Tool Repetition Detector"
            );
            messages.push(systemMessage);
          }

          await toolHandler.handleToolStartEvent(
            event.tool,
            event.args,
            tracingLogger,
            context
          );
          break;
        }

        case "tool_complete": {
          await toolHandler.handleToolCompleteEvent(
            event,
            tracingLogger,
            context
          );
          break;
        }

        case "done":
          if (event.response) {
            stateManager.setFinalResponse(event.response);
            
            // Log LLM metadata for debugging
            tracingLogger.info("[ReasonActLoop] Received 'done' event", {
              hasResponse: !!event.response,
              model: event.response.model,
              hasUsage: !!event.response.usage,
              promptTokens: event.response.usage?.prompt_tokens,
              completionTokens: event.response.usage?.completion_tokens,
            });
          }
          break;

        case "error":
          await this.handleErrorEvent(event, stateManager, eventContext, tracingLogger);
          break;
      }
    }

    return {
      events,
      hasToolCalls,
      toolResults,
      assistantMessage: assistantMessage.trim(),
    };
  }

  /**
   * Add tool results back to the conversation for the next iteration
   */
  private addToolResultsToConversation(
    messages: Message[],
    toolResults: ToolExecutionResult[],
    assistantMessage: string,
    tracingLogger: TracingLogger
  ): void {
    // Add the assistant's message (with reasoning and tool calls)
    if (assistantMessage) {
      const message = this.messageBuilder.formatAssistantMessage(assistantMessage);
      messages.push(message);
    }

    // Add tool results as user messages for the next iteration
    for (const result of toolResults) {
      const toolResultMessage = this.formatToolResultAsString(result);
      // Use MessageBuilder to create properly formatted user message
      const message = this.messageBuilder.formatUserMessage(toolResultMessage);
      messages.push(message);

      tracingLogger.info("[ReasonActLoop] Added tool result to conversation", {
        success: result.success,
        resultLength: toolResultMessage.length,
      });
    }
  }

  /**
   * Format a tool result as a string for inclusion in the conversation
   */
  private formatToolResultAsString(result: ToolExecutionResult): string {
    if (result.success) {
      // Format the output as a string
      const output = result.output;
      if (typeof output === "string") {
        return `Tool result: ${output}`;
      }
      if (output !== undefined && output !== null) {
        return `Tool result: ${JSON.stringify(output)}`;
      }
      return "Tool result: Success";
    }
    return `Tool error: ${result.error?.message || "Unknown error"}`;
  }

  /**
   * Handle the done event with metadata processing
   */

  private async handleContentEvent(
    event: { content: string },
    stateManager: StreamStateManager,
    eventContext: EventContext,
    context?: ExecutionContext
  ): Promise<void> {
    // Add content to streaming buffer in AgentPublisher (single source of truth)
    await this.agentPublisher.addStreamContent(event.content, eventContext);

    // Extract and log reasoning if present
    this.extractAndLogReasoning(this.agentPublisher.getBufferedContent(), context, stateManager);
  }

  private async handleErrorEvent(
    event: { error: string },
    stateManager: StreamStateManager,
    eventContext: EventContext,
    tracingLogger: TracingLogger
  ): Promise<void> {
    tracingLogger.error("Stream error", { error: event.error });
    // Add error to streaming buffer
    await this.agentPublisher.addStreamContent(`\n\nError: ${event.error}`, eventContext);
  }

  // Remove finalizeStream method as it's no longer needed

  private createLLMStream(
    context: ExecutionContext,
    messages: Message[],
    tools?: Tool[]
  ): ReturnType<LLMService["stream"]> {
    // Log what we're sending to the LLM
    logger.debug("[ReasonActLoop] Calling LLM stream", {
      agent: context.agent.name,
      phase: context.phase,
      messageCount: messages.length,
      toolCount: tools?.length || 0,
      toolNames: tools?.map((t) => t.name).join(", ") || "none",
    });

    // Log the actual messages being sent
    messages.forEach((msg, index) => {
      const preview =
        msg.content.length > 200 ? `${msg.content.substring(0, 200)}...` : msg.content;
      logger.debug(`[ReasonActLoop] Message ${index + 1}/${messages.length}`, {
        role: msg.role,
        contentLength: msg.content.length,
        preview,
      });
    });

    return this.llmService.stream({
      messages,
      options: {
        configName: context.agent.llmConfig,
        agentName: context.agent.name,
      },
      tools,
      toolContext: {
        ...context,
        conversationCoordinator: context.conversationCoordinator,
        agentPublisher: this.agentPublisher,
      },
    });
  }

  // Remove createStreamHandle method as it's no longer needed

  private createFinalEvent(stateManager: StreamStateManager): StreamEvent {
    const baseEvent: StreamEvent = {
      type: "done",
      response: stateManager.getFinalResponse() || {
        type: "text",
        content: this.agentPublisher.getBufferedContent(),
        toolCalls: [],
      },
    };

    // Add additional properties for AgentExecutor
    return Object.assign(baseEvent, {
      termination: undefined,
    }) as StreamEvent;
  }

  private async *handleError(
    error: unknown,
    tracingLogger: TracingLogger,
    context: ExecutionContext
  ): AsyncGenerator<StreamEvent> {
    tracingLogger.error("Streaming error", {
      error: formatAnyError(error),
      agent: context.agent.name,
    });

    // Try to flush any pending stream content
    try {
      await this.agentPublisher.publishStreamContent();
    } catch (finalizeError) {
      tracingLogger.error("Failed to publish stream on error", {
        error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
      });
    }

    // Stop typing indicator using AgentPublisher
    try {
      const conversation = context.conversationCoordinator.getConversation(context.conversationId);
      const eventContext: EventContext = {
        triggeringEvent: context.triggeringEvent,
        rootEvent: conversation?.history[0] ?? context.triggeringEvent,
        conversationId: context.conversationId,
      };
      await this.agentPublisher.typing({ type: "typing", state: "stop" }, eventContext);
    } catch (typingError) {
      tracingLogger.warning("Failed to stop typing indicator", {
        error: formatAnyError(typingError),
      });
    }

    yield {
      type: "error",
      error: formatAnyError(error),
    };
  }

  private logExecutionStart(
    tracingLogger: TracingLogger,
    context: ExecutionContext,
    tools?: Tool[]
  ): void {
    tracingLogger.info("🔄 Starting ReasonActLoop", {
      agent: context.agent.name,
      phase: context.phase,
      tools: tools?.map((t) => t.name).join(", "),
    });
  }

  private extractAndLogReasoning(
    content: string,
    context?: ExecutionContext,
    stateManager?: StreamStateManager
  ): void {
    if (!this.executionLogger || !context || !stateManager) return;

    // Extract thinking content
    const thinkingMatch = content.match(/<thinking>([\s\S]*?)<\/thinking>/g);
    if (!thinkingMatch) return;

    // Process each thinking block
    thinkingMatch.forEach((block) => {
      const contentMatch = block.match(/<thinking>([\s\S]*?)<\/thinking>/);
      if (!contentMatch || !contentMatch[1]) return;

      const thinkingContent = contentMatch[1].trim();

      // Check if this block has already been logged
      if (stateManager.hasThinkingBlockBeenLogged(thinkingContent)) {
        return; // Skip already logged blocks
      }

      // Mark this block as logged
      stateManager.markThinkingBlockLogged(thinkingContent);

      // Previously parsed reasoning data here but no longer needed
    });
  }
}
