import type { CompletionIntent, EventContext } from "@/nostr/AgentEventEncoder";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { buildLLMMetadata } from "@/prompts/utils/llmMetadata";
// ToolExecutionResult removed - using AI SDK tools only
import { getToolsObject } from "@/tools/registry";
import { formatAnyError } from "@/utils/error-formatter";
import { logger, logInfo, logError } from "@/utils/logger";
import { detectAndStripEOM } from "@/utils/eom-utils";
import { StreamStateManager } from "./StreamStateManager";
import { ToolStreamHandler } from "./ToolStreamHandler";
import type { ExecutionContext } from "./types";
import type { CoreMessage } from "ai";

// Maximum iterations to prevent infinite loops
const MAX_ITERATIONS = 20;

/**
 * ReasonActLoop implementation that properly implements the Reason-Act-Observe pattern.
 * Iteratively calls the LLM, executes tools, and feeds results back for further reasoning.
 */
export class ReasonActLoop {
  private startTime?: number;
  private agentPublisher!: AgentPublisher;
  private hasGeneratedContentPreviously = false;

  constructor(private llmService: any) {
    // AgentPublisher will be initialized in execute() when we have the agent
  }

  /**
   * Core execution implementation for all agents
   */
  async execute(messages: Array<CoreMessage>, tools: any[], context: ExecutionContext): Promise<void> {
    this.startTime = Date.now();
    this.hasGeneratedContentPreviously = false; // Reset for each execution

    // Use the shared AgentPublisher from context
    this.agentPublisher = context.agentPublisher;

    // Execute the streaming loop
    const generator = this.executeStreamingInternal(context, messages, tools);
    
    // Drain the generator
    for await (const _ of generator) {
      // Just drain it
    }
  }

  async *executeStreamingInternal(
    context: ExecutionContext,
    messages: CoreMessage[],
    tools?: Tool[]
  ): AsyncGenerator<any, void, unknown> {

    // Initialize handlers
    const stateManager = new StreamStateManager();
    const toolHandler = new ToolStreamHandler(stateManager, this.agentPublisher);

    this.logExecutionStart(context, tools);

    // Track conversation messages for the iterative loop
    const conversationMessages = [...messages];
    
    // Add initial EOM instruction
    const eomInstruction: CoreMessage = {
      role: "system",
      content: "When you have fully completed your task and have no further actions to take, you MUST put '=== EOM ===' on a new line by itself at the very end of your response. Do not include '=== EOM ===' if you plan to continue with more actions."
    };
    conversationMessages.push(eomInstruction);
    
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
        const last4Messages = conversationMessages.slice(-4).map(msg => ({
          role: msg.role,
          content: msg.content.length > 500 ? msg.content.substring(0, 500) + '...' : msg.content
        }));
        
        logger.info(`[ReasonActLoop] Starting iteration ${iterations}`, {
          iteration: iterations,
          shouldContinueLoop,
          agent: context.agent.slug,
          triggeringEventId: context.triggeringEvent.id,
          triggeringEventContent: context.triggeringEvent.content.substring(0, 40),
          messageCount: conversationMessages.length,
          last4Messages,
        });

        // Create stream with streamHandle in context
        const stream = this.createLLMStream(context, conversationMessages, tools);

        // Process stream events for this iteration
        const iterationResult = await this.processIterationStream(
          stream,
          stateManager,
          toolHandler,
          eventContext,
          context,
          conversationMessages
        );

        // Yield events from this iteration
        for (const event of iterationResult.events) {
          yield event;
        }

        // Check for EOM in assistant message first, before any other logic
        let cleanedAssistantMessage = iterationResult.assistantMessage;
        if (iterationResult.assistantMessage) {
          const { hasEOM, cleanContent } = detectAndStripEOM(iterationResult.assistantMessage);
          if (hasEOM) {
            cleanedAssistantMessage = cleanContent;
            shouldContinueLoop = false;
            logInfo(
              "[ReasonActLoop] Agent completed with EOM marker in message",
              "agent",
              "normal",
              {
                iteration: iterations,
                hasToolCalls: iterationResult.hasToolCalls,
                contentLength: cleanContent.length,
              }
            );
          }
        }

        // Check if we should continue iterating
        if (iterationResult.hasToolCalls) {
          logger.info("[ReasonActLoop] Processing tool results", {
            iteration: iterations,
            toolResultCount: iterationResult.toolResults.length,
            hasAssistantMessage: !!cleanedAssistantMessage,
            toolNames: iterationResult.toolResults.map(r => r.toolName).join(", "),
          });
          
          // Only set this flag if we're continuing (no EOM)
          if (shouldContinueLoop) {
            this.hasGeneratedContentPreviously = true;
          }
        } else if (this.agentPublisher.hasBufferedContent()) {
          // Agent generated content but no tool calls
          const bufferedContent = this.agentPublisher.getBufferedContent();
          const { hasEOM, cleanContent } = detectAndStripEOM(bufferedContent);
          
          if (hasEOM) {
            // Agent explicitly marked completion with EOM
            // Add FULL content (WITH EOM) to conversation so LLM knows it marked completion
            conversationMessages.push({ role: "assistant", content: bufferedContent });
            // Clear the buffer and re-add only the clean content (without the EOM marker) for publishing
            this.agentPublisher.clearBuffer();
            if (cleanContent.trim().length > 0) {
              // Re-add clean content (without EOM) for final publishing
              await this.agentPublisher.addStreamContent(cleanContent, eventContext);
            }
            logInfo(
              "[ReasonActLoop] Agent completed with EOM marker",
              "agent",
              "normal",
              {
                iteration: iterations,
                contentLength: cleanContent.length,
              }
            );
            shouldContinueLoop = false;
          } else {
            // No EOM marker - add reminder and continue
            conversationMessages.push({ role: "assistant", content: bufferedContent });
            const reminderMessage: CoreMessage = {
              role: "system",
              content: "If you are done with your work, put '=== EOM ===' on its own line. Otherwise, continue with your planned actions."
            };
            conversationMessages.push(reminderMessage);
            this.hasGeneratedContentPreviously = true;
            logInfo(
              "[ReasonActLoop] Agent generated content without EOM, continuing with reminder",
              "agent",
              "normal",
              {
                iteration: iterations,
                contentLength: bufferedContent.length,
              }
            );
            shouldContinueLoop = true;
          }
        } else if (this.hasGeneratedContentPreviously) {
          // Empty response after previous content - implicit completion
          logInfo(
            "[ReasonActLoop] Empty response after content, assuming completion",
            "agent",
            "normal",
            {
              iteration: iterations,
            }
          );
          shouldContinueLoop = false;
        } else {
          // No tool calls, no content from the start
          logger.warning("[ReasonActLoop] No tool calls, no content, ending loop", {
            iteration: iterations,
            possibleCause: "Model returned empty response - check model availability and context",
            lastResponseMetadata: stateManager.getFinalResponse() ? {
              model: stateManager.getFinalResponse()?.model,
              promptTokens: stateManager.getFinalResponse()?.usage?.prompt_tokens,
              completionTokens: stateManager.getFinalResponse()?.usage?.completion_tokens,
            } : null,
          });
          shouldContinueLoop = false;
        }

        // Stream finalization is no longer needed here
        // The streaming buffer is only for kind:21111 events
        // Final kind:1111 events come from StreamStateManager.fullContent via implicit/explicit completion
      }

      logger.info("[ReasonActLoop] Exited main loop", {
        iterations,
        shouldContinueLoop,
        reason: !shouldContinueLoop ? "completed" : "max iterations",
      });

      if (iterations >= MAX_ITERATIONS && shouldContinueLoop) {
        const error = new Error(
          `Agent ${context.agent.name} reached maximum iterations (${MAX_ITERATIONS}) without completing task`
        );
        logError(
          "[ReasonActLoop] Maximum iterations reached without completion",
          error,
          "agent"
        );
        throw error;
      }

      // Handle natural completion for ALL phases
      const fullContent = this.agentPublisher.getBufferedContent();
      this.agentPublisher.clearBuffer();
      
      if (fullContent.trim().length > 0) {
        // Build event context with all metadata
        const completionConversation = context.conversationCoordinator.getConversation(context.conversationId);
        const completionEventContext: EventContext = {
          triggeringEvent: context.triggeringEvent,
          rootEvent: completionConversation?.history[0] ?? context.triggeringEvent,
          conversationId: context.conversationId,
        };

        // Get LLM metadata for the completion event
        const finalResponse = stateManager.getFinalResponse();
        if (finalResponse) {
          const llmMetadata = await buildLLMMetadata(finalResponse, conversationMessages);
          if (llmMetadata) {
            completionEventContext.model = llmMetadata.model;
            completionEventContext.cost = llmMetadata.cost;
            completionEventContext.usage = {
              prompt_tokens: llmMetadata.promptTokens,
              completion_tokens: llmMetadata.completionTokens,
              total_tokens: llmMetadata.totalTokens,
            };
          }
        }

        // Tools publish their own events now, no need to track them here
        completionEventContext.executionTime = this.startTime ? Date.now() - this.startTime : undefined;
        completionEventContext.phase = context.phase;

        const naturalCompletionIntent: CompletionIntent = {
          type: 'completion',
          content: fullContent,
        };

        await this.agentPublisher.complete(naturalCompletionIntent, completionEventContext);
        
        logInfo(
          "[ReasonActLoop] Published natural completion",
          "agent",
          "normal",
          {
            agent: context.agent.name,
            phase: context.phase,
            contentLength: fullContent.length,
          }
        );
      }

      yield this.createFinalEvent(stateManager);
    } catch (error) {
      yield* this.handleError(error, context);
      throw error;
    }
  }

  /**
   * Process a single iteration of the stream and collect results
   */
  private async processIterationStream(
    stream: any, // AI SDK stream result
    stateManager: StreamStateManager,
    toolHandler: ToolStreamHandler,
    eventContext: EventContext,
    context: ExecutionContext,
    messages: CoreMessage[]
  ): Promise<{
    events: any[];
    hasToolCalls: boolean;
    toolResults: any[];
    assistantMessage: string;
  }> {
    const events: any[] = [];
    let hasToolCalls = false;
    const toolResults: any[] = [];
    let assistantMessage = "";

    // Process AI SDK stream
    for await (const chunk of stream.fullStream) {
      logger.info("[processIterationStream]", {
        agent: context.agent.name,
        type: chunk.type,
        content: (chunk as any).textDelta || (chunk as any).toolName,
      });
      events.push(chunk);

      switch (chunk.type) {
        case "text-delta":
          const delta = (chunk as any).textDelta || '';
          if (delta) {
            assistantMessage += delta;
            await this.agentPublisher.addStreamContent(delta, eventContext);
            stateManager.appendContent(delta);
          }
          break;

        case "tool-call": {
          hasToolCalls = true;
          // Tool call is starting
          const toolName = (chunk as any).toolName;
          const toolArgs = (chunk as any).args || {};
          logger.info("[ReasonActLoop] Tool call starting", { toolName, toolArgs });
          break;
        }

        case "tool-result": {
          hasToolCalls = true;
          // Tool result received
          const toolResult = (chunk as any).result;
          logger.info("[ReasonActLoop] Tool result received", { toolResult });
          break;
        }

        case "finish":
          // Stream finished
          logger.info("[ReasonActLoop] Stream finished");
          break;

        case "error":
          const error = (chunk as any).error;
          logger.error("[ReasonActLoop] Stream error", { error });
          throw error;
          break;
          
        default:
          // Other chunk types (step-finish, etc.)
          logger.debug("[ReasonActLoop] Other chunk type", { type: chunk.type });
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
   * Handle the done event with metadata processing
   */

  private async handleContentEvent(
    event: { content: string },
    stateManager: StreamStateManager,
    eventContext: EventContext,
    context?: ExecutionContext
  ): Promise<void> {
    // Strip EOM marker before sending to AgentPublisher
    const { cleanContent } = detectAndStripEOM(event.content);
    
    // Only add to publisher if there's content after stripping EOM
    if (cleanContent) {
      await this.agentPublisher.addStreamContent(cleanContent, eventContext);
    }

    // Extract and log reasoning if present
    this.extractAndLogReasoning(this.agentPublisher.getBufferedContent(), context, stateManager);
  }

  private async handleErrorEvent(
    event: { error: string },
    stateManager: StreamStateManager,
    eventContext: EventContext
  ): Promise<void> {
    logError("Stream error", event.error, "agent");
    // Add error to streaming buffer
    await this.agentPublisher.addStreamContent(`\n\nError: ${event.error}`, eventContext);
  }

  // Remove finalizeStream method as it's no longer needed

  private async createLLMStream(
    context: ExecutionContext,
    messages: CoreMessage[],
    tools?: Tool[]
  ) {
    const messagesPreview = messages.map((msg, index) => {
      const isToolResult = msg.role === "user" && msg.content.includes("Tool [");
      const preview = isToolResult
        ? msg.content // Show full tool results
        : msg.content.length > 500
          ? `${msg.content.substring(0, 500)}...`
          : msg.content;
      return preview;
    });
    
    // Log what we're sending to the LLM
    logger.info("[ReasonActLoop] Calling LLM stream", {
      agent: context.agent.name,
      phase: context.phase,
      messageCount: messages.length,
      toolCount: tools?.length || 0,
      toolNames: tools?.map((t) => t.name).join(", ") || "none",
      messagesPreview
    });

    // Get AI SDK tools directly
    const toolNames = tools?.map(t => t.name) || [];
    const aiTools = toolNames.length > 0 ? getToolsObject(toolNames, context) : undefined;
    
    // Use the agent's llmConfig as the model string (will be resolved by LLMService)
    const modelString = context.agent.llmConfig || "default";
    return this.llmService.stream(modelString, messages, { tools: aiTools });
  }

  // Remove createStreamHandle method as it's no longer needed

  private createFinalEvent(stateManager: StreamStateManager): any {
    const baseEvent: any = {
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
    });
  }

  private async *handleError(
    error: unknown,
    context: ExecutionContext
  ): AsyncGenerator<any> {
    logError(
      "Streaming error",
      error,
      "agent"
    );

    // Try to flush any pending stream content
    try {
      await this.agentPublisher.publishStreamContent();
    } catch (finalizeError) {
      logError(
        "Failed to publish stream on error",
        finalizeError,
        "agent"
      );
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
      logger.warning("Failed to stop typing indicator", {
        error: typingError
      });
    }

    yield {
      type: "error",
      error: formatAnyError(error),
    };
  }

  private logExecutionStart(
    context: ExecutionContext,
    tools?: Tool[]
  ): void {
    logInfo(
      "🔄 Starting ReasonActLoop",
      "agent",
      "verbose",
      {
        agent: context.agent.name,
        phase: context.phase,
        tools: tools?.map((t) => t.name).join(", "),
      }
    );
  }


  private extractAndLogReasoning(
    content: string,
    context?: ExecutionContext,
    stateManager?: StreamStateManager
  ): void {
    if (!context || !stateManager) return;

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
