import type { EventContext } from "@/nostr/AgentEventEncoder";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";
import { getToolsObject } from "@/tools/registry";
import type { ExecutionContext, StandaloneAgentContext } from "./types";
import type { AgentInstance } from "@/agents/types";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { configService } from "@/services";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { toolMessageStorage } from "@/conversations/persistence/ToolMessageStorage";
import type { MessageGenerationStrategy } from "./strategies/types";
import {
    ThreadWithMemoryStrategy
} from "./strategies";
import { getProjectContext } from "@/services";
import { providerSupportsStreaming } from "@/llm/provider-configs";

/**
 * Format MCP tool names for human readability
 * Converts "mcp__repomix__pack_codebase" to "repomix's pack_codebase"
 */
function formatMCPToolName(toolName: string): string {
    if (!toolName.startsWith('mcp__')) {
        return toolName;
    }
    
    // Split the MCP tool name: mcp__<server>__<tool>
    const parts = toolName.split('__');
    if (parts.length !== 3) {
        return toolName;
    }
    
    const [, serverName, toolMethod] = parts;
    
    // Simple format: server's tool_name
    return `${serverName}'s ${toolMethod.replace(/_/g, ' ')}`;
}

export interface LLMCompletionRequest {
    messages: ModelMessage[];
    tools?: Record<string, any>;
}

export class AgentExecutor {
    private messageStrategy: MessageGenerationStrategy;

    constructor(
        private standaloneContext?: StandaloneAgentContext,
        messageStrategy?: MessageGenerationStrategy
    ) {
        // Use provided strategy or select based on configuration
        this.messageStrategy = messageStrategy || this.selectStrategy();
    }

    /**
     * Select appropriate message generation strategy
     */
    private selectStrategy(): MessageGenerationStrategy {
        // Always use ThreadWithMemoryStrategy as it's now the only strategy
        return new ThreadWithMemoryStrategy();
    }

    /**
     * Prepare an LLM request without executing it.
     * This method builds the messages and determines the tools/configuration
     * but doesn't actually call the LLM. Used by BrainstormService.
     */
    async prepareLLMRequest(
        agent: AgentInstance,
        initialPrompt: string,
        originalEvent: NDKEvent,
        conversationHistory: ModelMessage[] = []
    ): Promise<LLMCompletionRequest> {
        // Build a minimal execution context for message generation
        const context: Partial<ExecutionContext> = {
            agent,
            triggeringEvent: originalEvent,
            conversationId: originalEvent.id, // Use event ID as conversation ID for stateless calls
            projectPath: process.cwd(),
        };

        // If we have conversation history, prepend it to the messages
        let messages: ModelMessage[] = [];
        
        if (conversationHistory.length > 0) {
            messages = [...conversationHistory];
        } else {
            // Build messages using the strategy if no history provided
            // Note: This requires a full ExecutionContext with conversationCoordinator
            // For brainstorming, we'll build messages manually
            messages = [
                {
                    role: "user",
                    content: initialPrompt
                }
            ];
        }

        // Get tools for the agent
        const toolNames = agent.tools || [];
        const tools = toolNames.length > 0 ? getToolsObject(toolNames, context as ExecutionContext) : {};

        return {
            messages,
            tools
        };
    }

    /**
     * Execute an agent's assignment for a conversation with streaming
     */
    async execute(context: ExecutionContext): Promise<void> {
        // Build messages using the strategy
        const messages = await this.messageStrategy.buildMessages(context, context.triggeringEvent);

        // Create AgentPublisher first so we can include it in context
        const agentPublisher = new AgentPublisher(
            context.agent
        );

        // Build full context with additional properties
        const fullContext: ExecutionContext = {
            ...context,
            conversationCoordinator: context.conversationCoordinator,
            agentPublisher, // Include the shared AgentPublisher instance
        };

        try {
            // Get fresh conversation data for execution time tracking
            const conversation = context.conversationCoordinator.getConversation(
                context.conversationId
            );
            if (!conversation) {
                throw new Error(`Conversation ${context.conversationId} not found`);
            }

            // Start execution time tracking
            startExecutionTime(conversation);

            // Extract transient phase context from triggering event if it's a delegate_phase
            const transientPhaseContext = this.extractPhaseContext(context.triggeringEvent);

            // Log execution flow start
            logger.info(
                `Agent ${context.agent.name} starting execution${transientPhaseContext?.phase ? ` in ${transientPhaseContext.phase} phase` : ''}`
            );

            // Publish typing indicator start using AgentPublisher
            const eventContext: EventContext = {
                triggeringEvent: context.triggeringEvent,
                rootEvent: conversation.history[0] ?? context.triggeringEvent, // Use triggering event as fallback
                conversationId: context.conversationId,
                model: context.agent.llmConfig, // Include LLM configuration
                phase: transientPhaseContext?.phase, // Include phase only if present
            };
            await agentPublisher.typing({ state: "start" }, eventContext);

            await this.executeWithStreaming(fullContext, messages);

            // Log execution flow complete
            logger.info(
                `Agent ${context.agent.name} completed execution successfully`
            );
        } catch (error) {
            // Log execution flow failure
            logger.error(`Agent ${context.agent.name} execution failed`, {
                conversationId: context.conversationId,
                agent: context.agent.name,
                error: formatAnyError(error),
                success: false,
            });
            throw error;
        } finally {
            const conversation = context.conversationCoordinator.getConversation(
                context.conversationId
            );
            if (conversation) stopExecutionTime(conversation);
            
            // Ensure typing indicator is stopped even on error
            try {
                const eventContext: EventContext = {
                    triggeringEvent: context.triggeringEvent,
                    rootEvent: conversation?.history[0] ?? context.triggeringEvent,
                    conversationId: context.conversationId,
                    model: context.agent.llmConfig, // Include LLM configuration
                };
                await agentPublisher.typing({ state: "stop" }, eventContext);
            } catch (typingError) {
                logger.warn("Failed to stop typing indicator", {
                    error: formatAnyError(typingError),
                });
            }
        }
    }

    /**
     * Extract phase context from triggering event if it contains delegate_phase tags
     */
    private extractPhaseContext(triggeringEvent: NDKEvent): { phase?: string; phaseInstructions?: string } | undefined {
        // Check if this is a phase delegation by looking for the tool tag
        const toolTag = triggeringEvent.tags.find(tag => tag[0] === 'tool' && tag[1] === 'delegate_phase');
        if (!toolTag) {
            return undefined;
        }

        // Extract phase name from phase tag
        const phaseTag = triggeringEvent.tags.find(tag => tag[0] === 'phase');
        if (!phaseTag || !phaseTag[1]) {
            return undefined;
        }

        // Extract phase instructions from phase-instructions tag (optional)
        const phaseInstructionsTag = triggeringEvent.tags.find(tag => tag[0] === 'phase-instructions');

        return {
            phase: phaseTag[1],
            phaseInstructions: phaseInstructionsTag?.[1]
        };
    }

    /**
     * Execute with streaming support
     */
    private async executeWithStreaming(
        context: ExecutionContext,
        messages: ModelMessage[]
    ): Promise<void> {
        // Get tools for response processing
        // Tools are already properly configured in AgentRegistry.buildAgentInstance
        const toolNames = context.agent.tools || [];

        // Get tools as a keyed object for AI SDK
        const toolsObject = toolNames.length > 0 ? getToolsObject(toolNames, context) : {};

        // Create a fresh LLMService instance for this execution
        // Use withAgent to create an LLMLogger instance with the agent name set
        const projectCtx = getProjectContext();
        const llmLogger = projectCtx.llmLogger.withAgent(context.agent.name);

        // Get stored session ID if available (for providers that support session resumption)
        const metadataStore = context.agent.createMetadataStore(context.conversationId);
        const sessionId = metadataStore.get<string>('sessionId');

        if (sessionId) {
            logger.info("[AgentExecutor] ✅ Found existing session to resume", {
                sessionId,
                agent: context.agent.name,
                conversationId: context.conversationId.substring(0, 8)
            });
        }

        // Pass tools context and session ID for providers that need runtime configuration (like Claude Code)
        const llmService = configService.createLLMService(
            llmLogger,
            context.agent.llmConfig,
            {
                tools: toolsObject,
                agentName: context.agent.name,
                sessionId
            }
        );

        // Extract transient phase context for event publishing
        const transientPhaseContext = this.extractPhaseContext(context.triggeringEvent);

        const agentPublisher = context.agentPublisher;
        const eventContext: EventContext = {
            triggeringEvent: context.triggeringEvent,
            rootEvent: context.conversationCoordinator.getConversation(context.conversationId)?.history[0] ?? context.triggeringEvent,
            conversationId: context.conversationId,
            phase: transientPhaseContext?.phase, // Use extracted phase, not context.phase
            model: llmService.model
        };

        // Separate buffers for content and reasoning
        let contentBuffer = '';
        let reasoningBuffer = '';

        // Helper to flush accumulated content
        const flushContentBuffer = async (): Promise<void> => {
            if (contentBuffer.trim().length > 0) {
                console.log('publishing conversation event', contentBuffer.substring(0, 50));
                
                // Use regular conversation event for content
                agentPublisher.conversation({
                    content: contentBuffer
                }, eventContext);
                logger.info(`[AgentExecutor] Flushed content buffer (${contentBuffer.length} chars)`);
                
                contentBuffer = '';
            }
        };

        // Helper to flush accumulated reasoning
        const flushReasoningBuffer = async (): Promise<void> => {
            if (reasoningBuffer.trim().length > 0) {
                console.log('publishing reasoning event', reasoningBuffer.substring(0, 50));
                
                // Use conversation event with reasoning tag
                agentPublisher.conversation({
                    content: reasoningBuffer,
                    isReasoning: true
                }, eventContext);
                logger.info(`[AgentExecutor] Flushed reasoning buffer (${reasoningBuffer.length} chars)`);
                
                reasoningBuffer = '';
            }
        };

        // Check if provider supports streaming
        const supportsStreaming = providerSupportsStreaming(llmService.provider as any);

        // Timeout tracker for non-streaming providers
        let publishTimeout: NodeJS.Timeout | null = null;
        let pendingContent = '';
        let pendingReasoning = '';

        // Helper to schedule publishing for non-streaming providers
        const schedulePublish = () => {
            if (publishTimeout) {
                clearTimeout(publishTimeout);
            }

            publishTimeout = setTimeout(async () => {
                if (pendingReasoning) {
                    await agentPublisher.conversation({
                        content: pendingReasoning,
                        isReasoning: true
                    }, eventContext);
                    pendingReasoning = '';
                }
                if (pendingContent) {
                    await agentPublisher.conversation({
                        content: pendingContent
                    }, eventContext);
                    pendingContent = '';
                }
                publishTimeout = null;
            }, 500);
        };

        // Wire up event handlers
        llmService.on('content', async (event) => {
            contentBuffer += event.delta;

            if (supportsStreaming) {
                // Still stream deltas for real-time display
                await agentPublisher.handleContent(event, eventContext, false);
            } else {
                // For non-streaming providers, accumulate and delay publish
                pendingContent += event.delta;
                schedulePublish();
            }
        });

        llmService.on('reasoning', async (event) => {
            reasoningBuffer += event.delta;

            if (supportsStreaming) {
                // Stream reasoning deltas for real-time display with reasoning flag
                await agentPublisher.handleContent(event, eventContext, true);
            } else {
                // For non-streaming providers, accumulate and delay publish
                pendingReasoning += event.delta;
                schedulePublish();
            }
        });
        
        llmService.on('chunk-type-change', async (event) => {
            logger.info(`[AgentExecutor] Chunk type changed from ${event.from} to ${event.to}`);
            // Flush both buffers on chunk type change
            await flushContentBuffer();
            await flushReasoningBuffer();
        });
        
        llmService.on('complete', async (event) => {
            // For non-streaming providers, clear any pending timeout
            if (!supportsStreaming) {
                if (publishTimeout) {
                    clearTimeout(publishTimeout);
                    publishTimeout = null;
                }
                // Clear pending content since we're handling it in complete
                pendingContent = '';
                pendingReasoning = '';
            }

            // Check if we had reasoning or content before flushing
            const hadContent = contentBuffer.trim().length > 0;
            const hadReasoning = reasoningBuffer.trim().length > 0;

            if (event.message.trim()) {
                const isReasoning = hadReasoning && !hadContent;

                await agentPublisher.complete({
                    content: event.message,
                    usage: event.usage,
                    isReasoning
                }, eventContext);

                logger.info(`[AgentExecutor] Agent ${context.agent.name} completed`, {
                    charCount: event.message.length,
                    isReasoning,
                    finishReason: event.finishReason
                });
            }

            // Clear buffers
            contentBuffer = '';
            reasoningBuffer = '';
        });
        
        llmService.on('stream-error', (event) => {
            logger.error("[AgentExecutor] Stream error from LLMService", event);
        });
        
        // Handle session capture - store any session ID from the provider
        llmService.on('session-captured', ({ sessionId }) => {
            const metadataStore = context.agent.createMetadataStore(context.conversationId);
            metadataStore.set('sessionId', sessionId);
            logger.info("[AgentExecutor] 💾 Stored session ID from provider", {
                sessionId,
                agent: context.agent.name,
                conversationId: context.conversationId.substring(0, 8)
            });
        });

        // Tool execution tracking - store tool calls with their event IDs
        const toolExecutions = new Map<string, { 
            toolCall: any; 
            toolResult: any;
            toolEventId: string;
        }>();

        llmService.on('tool-will-execute', async (event) => {
            logger.info('[AgentExecutor] Tool will execute', {
                toolName: event.toolName,
                toolCallId: event.toolCallId,
            });
            
            // Get the tool to generate human-readable content
            const tool = toolsObject[event.toolName];
            const humanContent = tool?.getHumanReadableContent?.(event.args)
                || (event.toolName.startsWith('mcp__')
                    ? `Executing ${formatMCPToolName(event.toolName)}`
                    : `Executing ${event.toolName}`);

            // Publish the tool event immediately when starting execution
            const toolEvent = await agentPublisher.toolUse(
                {
                    toolName: event.toolName,
                    content: humanContent,
                    args: event.args,
                },
                eventContext
            );

            // Store the tool call with its event ID for later association
            toolExecutions.set(event.toolCallId, {
                toolCall: {
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    input: event.args,
                },
                toolResult: null,
                toolEventId: toolEvent.id,
            });
        });

        llmService.on('tool-did-execute', async (event) => {
            logger.info('[AgentExecutor] Tool did execute', {
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                error: event.error,
            });

            // Get the stored execution with its event ID
            const execution = toolExecutions.get(event.toolCallId);
            if (execution) {
                // Update with tool result
                execution.toolResult = {
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    output: event.result,
                    error: event.error,
                };

                // Store the full tool messages to filesystem using the original event ID
                await toolMessageStorage.store(
                    execution.toolEventId,  // Use the event ID from when we started
                    execution.toolCall,
                    execution.toolResult,
                    context.agent.pubkey
                );
            }
        });

        try {
            // Register operation with the LLM Operations Registry
            const abortSignal = llmOpsRegistry.registerOperation(context);
            
            // Single LLM call - let it run up to 20 steps
            await llmService.stream(messages, toolsObject, { abortSignal });
        } finally {
            // Complete the operation (handles both success and abort cases)
            llmOpsRegistry.completeOperation(context);
            
            // Clean up event listeners
            llmService.removeAllListeners();
        }
    }
}
