import type { EventContext } from "@/nostr/AgentEventEncoder";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ModelMessage, Tool as CoreTool } from "ai";
import type { CompleteEvent } from "@/llm/service";
import { getToolsObject } from "@/tools/registry";
import type { ExecutionContext, StandaloneAgentContext } from "./types";
import type { AgentInstance } from "@/agents/types";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import type { MessageGenerationStrategy } from "./strategies/types";
import {
    ThreadWithMemoryStrategy
} from "./strategies";
import { providerSupportsStreaming } from "@/llm/provider-configs";
import type { AISdkProvider } from "@/llm/types";
import { buildBrainstormModerationPrompt } from "@/prompts/fragments/brainstorm-moderation";
import { ToolExecutionTracker } from "./ToolExecutionTracker";
import { AgentSupervisor } from "./AgentSupervisor";
import { extractPhaseContext } from "@/utils/phase-utils";

export interface LLMCompletionRequest {
    messages: ModelMessage[];
    tools?: Record<string, CoreTool>;
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
     * Type guard to check if a string is a valid AISdkProvider
     */
    private isAISdkProvider(provider: string): provider is AISdkProvider {
        const validProviders: readonly AISdkProvider[] = [
            "openrouter", 
            "anthropic", 
            "openai", 
            "ollama", 
            "claudeCode"
        ] as const;
        return (validProviders as readonly string[]).includes(provider);
    }


    /**
     * Create event filter for session resumption
     */
    private createEventFilter(
        sessionId: string | undefined,
        lastSentEventId: string | undefined
    ): ((event: NDKEvent) => boolean) | undefined {
        if (!sessionId || !lastSentEventId) {
            return undefined;
        }

        let foundLastSent = false;
        return (event: NDKEvent) => {
            // Skip events until we find the last sent one
            if (!foundLastSent) {
                if (event.id === lastSentEventId) {
                    foundLastSent = true;
                    logger.debug("[AgentExecutor] 🎯 Found last sent event, excluding it", {
                        eventId: event.id.substring(0, 8),
                        content: event.content?.substring(0, 50)
                    });
                    return false;
                }
                logger.debug("[AgentExecutor] ⏭️ Skipping event (before last sent)", {
                    eventId: event.id.substring(0, 8),
                    content: event.content?.substring(0, 50),
                    lookingFor: lastSentEventId.substring(0, 8)
                });
                return false;
            }
            logger.debug("[AgentExecutor] ✅ Including event (after last sent)", {
                eventId: event.id.substring(0, 8),
                content: event.content?.substring(0, 50)
            });
            return true;
        };
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
    async execute(context: ExecutionContext): Promise<NDKEvent | undefined> {
        // Prepare execution context with all necessary components
        const { fullContext, supervisor, toolTracker, agentPublisher, cleanup } = this.prepareExecution(context);

        try {
            // Start execution with supervision
            return await this.executeWithSupervisor(fullContext, supervisor, toolTracker, agentPublisher);
        } finally {
            // Always cleanup
            await cleanup();
        }
    }

    /**
     * Prepare execution context with all necessary components
     */
    private prepareExecution(context: ExecutionContext): {
        fullContext: ExecutionContext;
        supervisor: AgentSupervisor;
        toolTracker: ToolExecutionTracker;
        agentPublisher: AgentPublisher;
        cleanup: () => Promise<void>;
    } {
        // Create core components
        const toolTracker = new ToolExecutionTracker();
        const supervisor = new AgentSupervisor(context.agent, context, toolTracker);
        const agentPublisher = new AgentPublisher(context.agent);

        // Build full context with additional properties
        const fullContext: ExecutionContext = {
            ...context,
            conversationCoordinator: context.conversationCoordinator,
            agentPublisher,
            getConversation: () => context.conversationCoordinator.getConversation(context.conversationId),
        };

        // Get conversation for tracking
        const conversation = fullContext.getConversation();
        if (!conversation) {
            throw new Error(`Conversation ${context.conversationId} not found`);
        }

        // Start execution time tracking
        startExecutionTime(conversation);

        // Publish typing indicator start
        const eventContext = this.createEventContext(context);
        agentPublisher.typing({ state: "start" }, eventContext).catch(err =>
            logger.warn("Failed to start typing indicator", { error: err })
        );

        // Create cleanup function
        const cleanup = async (): Promise<void> => {
            logger.info('[AgentExecutor] 🧹 Cleanup: Stopping execution timer and clearing tracker', {
                agent: context.agent.name
            });

            if (conversation) stopExecutionTime(conversation);
            toolTracker.clear();

            // Ensure typing indicator is stopped
            try {
                const eventContext = this.createEventContext(context);
                await agentPublisher.typing({ state: "stop" }, eventContext);
            } catch (typingError) {
                logger.warn("Failed to stop typing indicator", {
                    error: formatAnyError(typingError),
                });
            }
        };

        return { fullContext, supervisor, toolTracker, agentPublisher, cleanup };
    }

    /**
     * Execute with supervisor oversight and retry capability
     */
    private async executeWithSupervisor(
        context: ExecutionContext,
        supervisor: AgentSupervisor,
        toolTracker: ToolExecutionTracker,
        agentPublisher: AgentPublisher
    ): Promise<NDKEvent | undefined> {
        logger.info('[AgentExecutor] 🎬 Starting supervised execution', {
            agent: context.agent.name,
            conversationId: context.conversationId.substring(0, 8),
            hasPhases: !!context.agent.phases,
            phaseCount: context.agent.phases ? Object.keys(context.agent.phases).length : 0
        });

        // Stream the LLM response
        const completionEvent = await this.executeStreaming(context, toolTracker);

        // Check if the execution is complete
        if (!completionEvent) {
            logger.error('[AgentExecutor] ❌ No completion event received', {
                agent: context.agent.name
            });
            return undefined;
        }

        const isComplete = await supervisor.isExecutionComplete(completionEvent);

        if (!isComplete) {
            logger.info('[AgentExecutor] 🔁 RECURSION: Execution not complete, continuing', {
                agent: context.agent.name,
                reason: supervisor.getContinuationPrompt()
            });

            // Only publish intermediate if we had actual content
            if (completionEvent.message?.trim()) {
                logger.info('[AgentExecutor] Publishing intermediate conversation', {
                    agent: context.agent.name,
                    contentLength: completionEvent.message.length
                });
                const eventContext = this.createEventContext(context);
                await agentPublisher.conversation({
                    content: completionEvent.message
                }, eventContext);
            }

            // Get continuation instructions from supervisor
            context.additionalSystemMessage = supervisor.getContinuationPrompt();

            logger.info('[AgentExecutor] 🔄 Resetting supervisor and recursing', {
                agent: context.agent.name,
                systemMessage: context.additionalSystemMessage
            });

            // Reset supervisor and recurse
            supervisor.reset();
            return this.executeWithSupervisor(context, supervisor, toolTracker, agentPublisher);
        }

        logger.info('[AgentExecutor] ✅ Execution complete, publishing final response', {
            agent: context.agent.name,
            hasReasoning: !!completionEvent.reasoning,
            messageLength: completionEvent.message?.length || 0
        });

        // Check if there was a phase validation decision to publish
        const phaseDecision = supervisor.getPhaseValidationDecision();
        if (phaseDecision) {
            logger.info('[AgentExecutor] 📝 Publishing phase validation decision', {
                agent: context.agent.name,
                decisionLength: phaseDecision.length
            });
            const eventContext = this.createEventContext(context, completionEvent.usage?.model);
            await agentPublisher.conversation({
                content: phaseDecision,
                isReasoning: true
            }, eventContext);
        }

        // Execution is complete - publish and return
        const eventContext = this.createEventContext(context, completionEvent.usage?.model);
        const finalResponseEvent = await agentPublisher.complete({
            content: completionEvent.message,
            reasoning: completionEvent.reasoning,
            usage: completionEvent.usage
        }, eventContext);

        logger.info('[AgentExecutor] 🎯 Published final completion event', {
            agent: context.agent.name,
            eventId: finalResponseEvent?.id,
            usage: completionEvent.usage
        });

        return finalResponseEvent;
    }

    /**
     * Create EventContext for publishing events
     */
    private createEventContext(
        context: ExecutionContext,
        model?: string
    ): EventContext {
        const conversation = context.getConversation();
        // Extract phase directly from triggering event if it's a phase delegation
        const phaseContext = extractPhaseContext(context.triggeringEvent);

        return {
            triggeringEvent: context.triggeringEvent,
            rootEvent: conversation?.history[0] ?? context.triggeringEvent,
            conversationId: context.conversationId,
            model: model ?? context.agent.llmConfig,
            phase: phaseContext?.phase
        };
    }

    /**
     * Format error for stream/execution errors
     */
    private formatStreamError(error: unknown): { message: string; errorType: string } {
        let errorMessage = "An error occurred while processing your request.";
        let errorType = "system";

        if (error instanceof Error) {
            const errorStr = error.toString();
            if (errorStr.includes("AI_APICallError") ||
                errorStr.includes("Provider returned error") ||
                errorStr.includes("422") ||
                errorStr.includes("openrouter")) {
                errorType = "ai_api";

                // Extract meaningful error details
                const providerMatch = errorStr.match(/provider_name":"([^"]+)"/);
                const provider = providerMatch ? providerMatch[1] : "AI provider";
                errorMessage = `Failed to process request with ${provider}. The AI service returned an error.`;

                // Add raw error details if available
                const rawMatch = errorStr.match(/raw":"([^"]+)"/);
                if (rawMatch) {
                    errorMessage += ` Details: ${rawMatch[1]}`;
                }
            } else {
                errorMessage = `Error: ${error.message}`;
            }
        }

        return { message: errorMessage, errorType };
    }


    /**
     * Execute streaming and return the completion event
     */
    private async executeStreaming(
        context: ExecutionContext,
        toolTracker: ToolExecutionTracker
    ): Promise<CompleteEvent | undefined> {
        // Get tools for response processing
        // Tools are already properly configured in AgentRegistry.buildAgentInstance
        const toolNames = context.agent.tools || [];

        // Get tools as a keyed object for AI SDK
        const toolsObject = toolNames.length > 0 ? getToolsObject(toolNames, context) : {};

        // Get stored session ID and last sent event ID if available (for providers that support session resumption)
        const metadataStore = context.agent.createMetadataStore(context.conversationId);
        let sessionId = metadataStore.get<string>('sessionId');
        const lastSentEventId = metadataStore.get<string>('lastSentEventId');

        if (sessionId) {
            logger.info("[AgentExecutor] ✅ Found existing session to resume", {
                sessionId,
                agent: context.agent.name,
                conversationId: context.conversationId.substring(0, 8),
                lastSentEventId: lastSentEventId || 'NONE'
            });
        }

        // Create event filter for Claude Code sessions
        const eventFilter = this.createEventFilter(sessionId, lastSentEventId);
        
        if (eventFilter && lastSentEventId) {
            logger.info("[AgentExecutor] 📋 Created event filter for resumed session", {
                lastSentEventId: lastSentEventId.substring(0, 8),
                willFilterEvents: true
            });
        }

        // Build messages using the strategy, with optional filter for resumed sessions
        let messages = await this.messageStrategy.buildMessages(
            context,
            context.triggeringEvent,
            eventFilter
        );

        // Add any additional system message from retry
        if (context.additionalSystemMessage) {
            messages = [...messages, {
                role: 'system',
                content: context.additionalSystemMessage
            }];
            // Clear it after use
            delete context.additionalSystemMessage;
        }

        logger.debug("[AgentExecutor] 📝 Built messages for execution", {
            messageCount: messages.length,
            hasFilter: !!eventFilter,
            sessionId: sessionId || 'NONE',
            messageTypes: messages.map((msg, i) => {
                const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                return {
                    index: i,
                    role: msg.role,
                    contentLength: contentStr.length,
                    contentPreview: contentStr.substring(0, 100)
                };
            })
        });

        // Pass tools context and session ID for providers that need runtime configuration (like Claude Code)
        const llmService = context.agent.createLLMService({ tools: toolsObject, sessionId });

        const agentPublisher = context.agentPublisher;
        const eventContext = this.createEventContext(context, llmService.model);

        // Separate buffers for content and reasoning
        let contentBuffer = '';
        let reasoningBuffer = '';
        let completionEvent: CompleteEvent | undefined;

        // Timeout for non-streaming intermediate event publishing
        let intermediatePublishTimeout: NodeJS.Timeout | undefined;

        // Check if provider supports streaming
        const supportsStreaming = this.isAISdkProvider(llmService.provider)
            ? providerSupportsStreaming(llmService.provider)
            : true;

        // Helper to flush accumulated reasoning
        const flushReasoningBuffer = async (): Promise<void> => {
            if (reasoningBuffer.trim().length > 0) {
                logger.info(`[AgentExecutor] Flushing reasoning buffer (${reasoningBuffer.length} chars)`, {
                    preview: reasoningBuffer.substring(0, 50),
                    agentName: context.agent.name
                });

                // Publish reasoning as kind:1111 with reasoning tag
                await agentPublisher.conversation({
                    content: reasoningBuffer,
                    isReasoning: true
                }, eventContext);

                reasoningBuffer = '';
            }
        };

        // Wire up event handlers
        llmService.on('content', async (event) => {
            logger.debug("[AgentExecutor] RECEIVED CONTENT EVENT!!!", {
                deltaLength: event.delta?.length,
                supportsStreaming,
                preview: event.delta?.substring(0, 100),
                agentName: context.agent.name,
            });

            // Only accumulate in buffer for streaming providers
            // Non-streaming providers publish each chunk directly and use event.message from onFinish
            if (supportsStreaming) {
                contentBuffer += event.delta;
            }

            // Publish chunks for display
            if (supportsStreaming) {
                // For streaming providers, publish as streaming deltas (kind:21111)
                await agentPublisher.publishStreamingDelta(event.delta, eventContext, false);
            } else {
                // For non-streaming providers, buffer the intermediate event with a 250ms delay
                // This prevents duplicate publishing when complete event arrives quickly
                intermediatePublishTimeout = setTimeout(() => {
                    agentPublisher.conversation({ content: event.delta }, eventContext);
                    intermediatePublishTimeout = undefined;
                }, 250);
            }
        });

        llmService.on('reasoning', async (event) => {
            // Only accumulate in buffer for streaming providers
            // Non-streaming providers publish each chunk directly
            if (supportsStreaming) {
                reasoningBuffer += event.delta;
            }

            // Publish chunks for display
            if (supportsStreaming) {
                // For streaming providers, publish as streaming deltas (kind:21111)
                await agentPublisher.publishStreamingDelta(event.delta, eventContext, true);
            } else {
                // For non-streaming providers, publish as conversation events (kind:1111)
                await agentPublisher.conversation({
                    content: event.delta,
                    isReasoning: true
                }, eventContext);
            }
        });

        llmService.on('chunk-type-change', async (event) => {
            logger.debug(`[AgentExecutor] Chunk type changed from ${event.from} to ${event.to}`, {
                agentName: context.agent.name,
                hasReasoningBuffer: reasoningBuffer.length > 0,
                hasContentBuffer: contentBuffer.length > 0
            });

            // When switching FROM reasoning to anything else (text-start, text-delta, etc)
            // flush reasoning as complete event
            if (event.from === 'reasoning-delta') {
                await flushReasoningBuffer();
            }
        });

        llmService.on('complete', (event) => {
            // Cancel any pending intermediate event publication
            if (intermediatePublishTimeout) {
                clearTimeout(intermediatePublishTimeout);
                intermediatePublishTimeout = undefined;
            }

            // Store the completion event
            completionEvent = event;

            logger.info("[AgentExecutor] LLM complete event received", {
                agent: context.agent.name,
                messageLength: event.message?.length || 0,
                hasMessage: !!event.message,
                hasReasoning: !!event.reasoning,
                finishReason: event.finishReason
            });
        });
        
        llmService.on('stream-error', async (event) => {
            logger.error("[AgentExecutor] Stream error from LLMService", event);

            // Reset streaming sequence on error
            agentPublisher.resetStreamingSequence();

            // Publish error event to Nostr for visibility
            try {
                const { message: errorMessage, errorType } = this.formatStreamError(event.error);

                await agentPublisher.error({
                    message: errorMessage,
                    errorType
                }, eventContext);

                logger.info("Stream error event published via stream-error handler", {
                    agent: context.agent.name,
                    errorType,
                });
            } catch (publishError) {
                logger.error("Failed to publish stream error event", {
                    error: formatAnyError(publishError),
                });
            }
        });
        
        // Handle session capture - store any session ID from the provider
        llmService.on('session-captured', ({ sessionId: capturedSessionId }) => {
            const metadataStore = context.agent.createMetadataStore(context.conversationId);
            metadataStore.set('sessionId', capturedSessionId);
            // Also store the current triggering event as the last sent event
            metadataStore.set('lastSentEventId', context.triggeringEvent.id);
            // Update the local sessionId variable so it's available in the closure
            sessionId = capturedSessionId;
            logger.info("[AgentExecutor] 💾 Stored session ID and last sent event from provider", {
                sessionId: capturedSessionId,
                lastSentEventId: context.triggeringEvent.id.substring(0, 8),
                agent: context.agent.name,
                conversationId: context.conversationId.substring(0, 8)
            });
        });

        // Tool tracker is always provided from executeWithSupervisor

        llmService.on('tool-will-execute', async (event) => {
            await toolTracker.trackExecution({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
                toolsObject,
                agentPublisher,
                eventContext
            });
        });

        llmService.on('tool-did-execute', async (event) => {
            await toolTracker.completeExecution({
                toolCallId: event.toolCallId,
                result: event.result,
                error: event.error ?? false,
                agentPubkey: context.agent.pubkey
            });
        });

        try {
            // Register operation with the LLM Operations Registry
            const abortSignal = llmOpsRegistry.registerOperation(context);

            await llmService.stream(messages, toolsObject, { abortSignal });
        } catch (streamError) {
            // Publish error event for stream errors
            try {
                const { message: errorMessage, errorType } = this.formatStreamError(streamError);

                await agentPublisher.error({
                    message: errorMessage,
                    errorType
                }, eventContext);

                logger.info("Stream error event published to Nostr", {
                    agent: context.agent.name,
                    errorType,
                });
            } catch (publishError) {
                logger.error("Failed to publish stream error event", {
                    agent: context.agent.name,
                    error: formatAnyError(publishError),
                });
            }

            // Re-throw to let parent handler catch it
            throw streamError;
        } finally {
            // Complete the operation (handles both success and abort cases)
            llmOpsRegistry.completeOperation(context);

            // Clean up event listeners
            llmService.removeAllListeners();
        }

        // After streaming, handle cleanup and post-processing
        logger.debug('[AgentExecutor] 🏃 Stream completed, handling post-processing', {
            agent: context.agent.name,
            hasCompletionEvent: !!completionEvent,
            hasReasoningBuffer: reasoningBuffer.trim().length > 0
        });

        if (reasoningBuffer.trim().length > 0) {
            await flushReasoningBuffer();
        }

        // Reset streaming sequence counter for next stream
        agentPublisher.resetStreamingSequence();

        // Store lastSentEventId for new Claude Code sessions
        if (!sessionId && context.agent.llmConfig.provider === 'claudeCode' && completionEvent) {
            const metadataStore = context.agent.createMetadataStore(context.conversationId);
            metadataStore.set('lastSentEventId', context.triggeringEvent.id);
            logger.info("[AgentExecutor] 📝 Stored lastSentEventId for new Claude Code session", {
                lastSentEventId: context.triggeringEvent.id.substring(0, 8),
                agent: context.agent.name,
                conversationId: context.conversationId.substring(0, 8)
            });
        }

        return completionEvent;
    }

    /**
     * Execute brainstorm moderation to select the best response(s)
     * @param context - Execution context with moderator agent
     * @param responses - Array of brainstorm responses to choose from
     * @returns The selected agents' pubkeys and optional reasoning
     */
    async executeBrainstormModeration(
        context: ExecutionContext,
        responses: Array<{ agent: { pubkey: string; name: string }; content: string; event: NDKEvent }>
    ): Promise<{ selectedAgents: string[]; reasoning?: string } | null> {
        try {
            // Build messages using the strategy to get the moderator's full identity
            const messages = await this.messageStrategy.buildMessages(context, context.triggeringEvent);

            // Keep only system messages (agent identity, instructions, etc)
            const moderationMessages: ModelMessage[] = messages.filter(msg => msg.role === "system");

            // Add the moderation prompt messages
            const promptMessages = buildBrainstormModerationPrompt(
                context.triggeringEvent.content,
                responses.map(r => ({
                    name: r.agent.name,
                    pubkey: r.agent.pubkey,
                    content: r.content
                }))
            );
            moderationMessages.push(...promptMessages);

            logger.debug("[AgentExecutor] Executing brainstorm moderation", {
                moderator: context.agent.name,
                responseCount: responses.length,
                agents: responses.map(r => ({ name: r.agent.name, pubkey: r.agent.pubkey })),
                messageCount: moderationMessages.length
            });

            // Use regular text generation instead of generateObject
            // since Claude via OpenRouter doesn't support it well
            const response = await this.generateTextResponse(moderationMessages, context);

            if (!response) {
                logger.error("[AgentExecutor] No response from moderator");
                return null;
            }

            // Parse JSON from response
            let parsed: { selectedAgents: string[]; reasoning?: string };
            try {
                // Clean the response - remove markdown code blocks if present
                const cleaned = response
                    .replace(/```json\n?/g, '')
                    .replace(/```\n?/g, '')
                    .trim();

                parsed = JSON.parse(cleaned);
            } catch (parseError) {
                logger.error("[AgentExecutor] Failed to parse moderation response as JSON", {
                    response: response.substring(0, 200),
                    error: parseError instanceof Error ? parseError.message : String(parseError)
                });
                return null;
            }

            // Handle both single and multiple selections
            const selectedPubkeys = Array.isArray(parsed.selectedAgents)
                ? parsed.selectedAgents
                : [parsed.selectedAgents];

            if (selectedPubkeys.length === 0) {
                logger.info("[AgentExecutor] No agents selected by moderator - defaulting to all responses");
                return {
                    selectedAgents: responses.map(r => r.agent.pubkey),
                    reasoning: parsed.reasoning || "Moderator did not select specific responses - including all"
                };
            }

            // Validate all selected agents exist and map to their pubkeys
            const validatedPubkeys: string[] = [];
            for (const selection of selectedPubkeys) {
                const matchingResponse = responses.find(r =>
                    r.agent.pubkey === selection ||
                    r.agent.name === selection
                );

                if (matchingResponse) {
                    validatedPubkeys.push(matchingResponse.agent.pubkey);
                } else {
                    logger.warn("[AgentExecutor] Selected agent not found", {
                        selected: selection,
                        available: responses.map(r => ({ name: r.agent.name, pubkey: r.agent.pubkey }))
                    });
                }
            }

            if (validatedPubkeys.length === 0) {
                logger.error("[AgentExecutor] No valid agents in selection");
                return null;
            }

            logger.info("[AgentExecutor] Moderation complete", {
                moderator: context.agent.name,
                selectedCount: validatedPubkeys.length,
                selectedAgents: validatedPubkeys,
                reasoning: parsed.reasoning?.substring(0, 100)
            });

            return {
                selectedAgents: validatedPubkeys,
                reasoning: parsed.reasoning
            };

        } catch (error) {
            logger.error("[AgentExecutor] Brainstorm moderation failed", {
                error: error instanceof Error ? error.message : String(error),
                moderator: context.agent.name
            });
            return null;
        }
    }

    /**
     * Generate a text response using the LLM service
     */
    private async generateTextResponse(
        messages: ModelMessage[],
        context: ExecutionContext
    ): Promise<string | null> {
        try {
            const llmService = context.agent.createLLMService();

            // Use complete() since we don't need streaming
            const result = await llmService.complete(
                messages,
                {}  // no tools needed for moderation
            );

            return result.text?.trim() || null;
        } catch (error) {
            logger.error("[AgentExecutor] Failed to generate text response", {
                error: error instanceof Error ? error.message : String(error)
            });
            return null;
        }
    }
}
