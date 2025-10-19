import type { LLMLogger } from "@/logging/LLMLogger";
import type { AISdkTool } from "@/tools/registry";
import { logger } from "@/utils/logger";
import { compileMessagesForClaudeCode, convertSystemMessagesForResume } from "./utils/claudeCodePromptCompiler";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { ProgressMonitor } from "@/agents/execution/ProgressMonitor";
import { throttlingMiddleware } from "./middleware/throttlingMiddleware";
import { isAISdkProvider } from "./type-guards";
import { providerSupportsStreaming } from "./provider-configs";
import {
    type LanguageModelUsage,
    type LanguageModel,
    type StepResult,
    type TextStreamPart,
    type ProviderRegistry,
    type GenerateTextResult,
    type Experimental_LanguageModelV1Middleware,
    generateText,
    generateObject,
    streamText,
    wrapLanguageModel,
    extractReasoningMiddleware,
} from "ai";
import type { JSONValue } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { EventEmitter } from "tseep";
import type { LanguageModelUsageWithCostUsd } from "./types";
import type { z } from "zod";
import { trace, SpanStatusCode } from "@opentelemetry/api";

/**
 * Content delta event
 */
interface ContentEvent {
    delta: string;
}

/**
 * Chunk type change event
 */
interface ChunkTypeChangeEvent {
    from: string | undefined;
    to: string;
}

/**
 * Tool will execute event
 */
interface ToolWillExecuteEvent {
    toolName: string;
    toolCallId: string;
    args: unknown;
}

/**
 * Tool did execute event
 */
interface ToolDidExecuteEvent {
    toolName: string;
    toolCallId: string;
    result: unknown;
    error?: boolean;
}

/**
 * Completion event
 */
export interface CompleteEvent {
    message: string;
    steps: StepResult<Record<string, AISdkTool>>[];
    usage: LanguageModelUsageWithCostUsd;
    finishReason?: string;
}

/**
 * Stream error event
 */
interface StreamErrorEvent {
    error: unknown;
}

/**
 * Session captured event
 */
interface SessionCapturedEvent {
    sessionId: string;
}

/**
 * Reasoning delta event
 */
interface ReasoningEvent {
    delta: string;
}

/**
 * Event map for LLMService with proper typing
 */
interface LLMServiceEvents {
    content: (data: ContentEvent) => void;
    "chunk-type-change": (data: ChunkTypeChangeEvent) => void;
    "tool-will-execute": (data: ToolWillExecuteEvent) => void;
    "tool-did-execute": (data: ToolDidExecuteEvent) => void;
    complete: (data: CompleteEvent) => void;
    "stream-error": (data: StreamErrorEvent) => void;
    "session-captured": (data: SessionCapturedEvent) => void;
    reasoning?: (data: ReasoningEvent) => void;
}

/**
 * Provider metadata structure from AI SDK
 */
type ProviderMetadata = Record<string, Record<string, JSONValue>>;

/**
 * LLM Service for runtime execution with AI SDK providers
 * Pure runtime concerns - no configuration management
 */
export class LLMService extends EventEmitter<LLMServiceEvents> {
    public readonly provider: string;
    public readonly model: string;
    private readonly temperature?: number;
    private readonly maxTokens?: number;
    private previousChunkType?: string;
    private readonly claudeCodeProviderFunction?: (model: string, options?: ClaudeCodeSettings) => LanguageModel;
    private readonly sessionId?: string;
    private readonly agentSlug?: string;
    private contentPublishTimeout?: NodeJS.Timeout;
    private cachedContentForComplete: string = "";

    constructor(
        private readonly llmLogger: LLMLogger,
        private readonly registry: ProviderRegistry | null,
        provider: string,
        model: string,
        temperature?: number,
        maxTokens?: number,
        claudeCodeProviderFunction?: (model: string, options?: ClaudeCodeSettings) => LanguageModel,
        sessionId?: string,
        agentSlug?: string
    ) {
        super();
        this.provider = provider;
        this.model = model;
        this.temperature = temperature;
        this.maxTokens = maxTokens;
        this.claudeCodeProviderFunction = claudeCodeProviderFunction;
        this.sessionId = sessionId;
        this.agentSlug = agentSlug;

        if (!registry && !claudeCodeProviderFunction) {
            throw new Error("LLMService requires either a registry or Claude Code provider function");
        }

        logger.debug("[LLMService] 🆕 INITIALIZED", {
            provider: this.provider,
            model: this.model,
            temperature: this.temperature,
            maxTokens: this.maxTokens,
            isClaudeCode: provider === "claudeCode",
            sessionId: this.sessionId || "NONE",
            hasSessionId: !!this.sessionId,
        });
    }

    /**
     * Get full telemetry configuration for AI SDK
     * Captures EVERYTHING for debugging - no privacy filters
     */
    private getFullTelemetryConfig(): any {
        return {
            isEnabled: true,
            functionId: `${this.agentSlug || "unknown"}.${this.provider}.${this.model}`,

            // Metadata for debugging context
            metadata: {
                "agent.slug": this.agentSlug || "unknown",
                "llm.provider": this.provider,
                "llm.model": this.model,
                "llm.temperature": this.temperature,
                "llm.max_tokens": this.maxTokens,
                "session.id": this.sessionId,
            },

            // FULL DATA - no privacy filters for debugging
            recordInputs: true,   // Capture full prompts
            recordOutputs: true,  // Capture full responses
        };
    }

    /**
     * Determine if throttling middleware should be used for this provider
     * claudeCode handles its own streaming optimization, so it doesn't need throttling
     */
    private shouldUseThrottlingMiddleware(): boolean {
        return this.provider !== "claudeCode";
    }

    /**
     * Get a language model instance.
     * For Claude Code: Creates model with system prompt from messages.
     * For standard providers: Gets model from registry.
     * Wraps all models with throttling middleware and extract-reasoning-middleware.
     */
    private getLanguageModel(messages?: ModelMessage[], enableThrottling: boolean = true): LanguageModel {
        let baseModel: LanguageModel;

        if (this.claudeCodeProviderFunction) {
            // Claude Code provider
            const options: ClaudeCodeSettings = {};

            if (this.sessionId) {
                // When resuming, only pass the resume option
                options.resume = this.sessionId;
                logger.debug("[LLMService] 🔄 RESUMING CLAUDE CODE SESSION", {
                    sessionId: this.sessionId,
                    model: this.model,
                    optionsKeys: Object.keys(options),
                    messagesProvided: messages?.length || 0,
                    messageRoles: messages?.map(m => m.role),
                });
            } else if (messages) {
                // When NOT resuming, compile all messages
                const { customSystemPrompt, appendSystemPrompt } = compileMessagesForClaudeCode(messages);

                options.customSystemPrompt = customSystemPrompt;
                if (appendSystemPrompt) {
                    options.appendSystemPrompt = appendSystemPrompt;
                }

                logger.debug("[LLMService] 🆕 NEW CLAUDE CODE SESSION (no resume)", {
                    model: this.model,
                    hasCustomPrompt: !!customSystemPrompt,
                    hasAppendPrompt: !!appendSystemPrompt,
                    appendPromptLength: appendSystemPrompt?.length || 0,
                    optionsKeys: Object.keys(options)
                });
            }

            baseModel = this.claudeCodeProviderFunction(this.model, options);

            logger.debug("[LLMService] 🎯 CREATED CLAUDE CODE MODEL", {
                model: this.model,
                hasCustomSystemPrompt: !!options.customSystemPrompt,
                hasAppendSystemPrompt: !!options.appendSystemPrompt,
                resumeSessionId: options.resume || "NONE",
                hasResume: "resume" in options
            });
        } else if (this.registry) {
            // Standard providers use registry
            baseModel = this.registry.languageModel(`${this.provider}:${this.model}`);
        } else {
            throw new Error("No provider available for model creation");
        }

        // Build middleware chain
        const middlewares: Experimental_LanguageModelV1Middleware[] = [];

        // Add throttling middleware for streaming (when enabled)
        // Check if this provider should use throttling middleware
        if (enableThrottling && this.shouldUseThrottlingMiddleware()) {
            middlewares.push(throttlingMiddleware({
                flushInterval: 500, // Flush every 500ms after first chunk
                chunking: "line" // Use line-based chunking for clean breaks
            }));
        }

        // Add extract-reasoning-middleware to handle thinking tags
        middlewares.push(extractReasoningMiddleware({
            tagName: "thinking",
            separator: "\n",
            startWithReasoning: false,
        }));

        // Wrap with all middlewares
        const wrappedModel = wrapLanguageModel({
            model: baseModel,
            middleware: middlewares,
        });

        // Preserve tools property from baseModel if it exists
        // wrapLanguageModel doesn't preserve custom properties, so we need to manually copy them
        if ('tools' in baseModel && (baseModel as any).tools) {
            (wrappedModel as any).tools = (baseModel as any).tools;
        }

        return wrappedModel;
    }

    /**
     * Add provider-specific cache control to messages.
     * Only Anthropic requires explicit cache control; OpenAI and Gemini cache automatically.
     */
    private addCacheControl(messages: ModelMessage[]): ModelMessage[] {
        // Only add cache control for Anthropic
        if (this.provider !== "anthropic" && this.provider !== "gemini-cli") {
            return messages;
        }

        // Rough estimate: 4 characters per token (configurable if needed)
        const CHARS_PER_TOKEN_ESTIMATE = 4;
        const MIN_TOKENS_FOR_CACHE = 1024;
        const minCharsForCache = MIN_TOKENS_FOR_CACHE * CHARS_PER_TOKEN_ESTIMATE;

        return messages.map((msg) => {
            // Only cache system messages and only if they're large enough
            if (msg.role === "system" && msg.content.length > minCharsForCache) {
                return {
                    ...msg,
                    providerOptions: {
                        anthropic: {
                            cacheControl: { type: "ephemeral" }
                        }
                    }
                };
            }
            return msg;
        });
    }

    async complete(
        messages: ModelMessage[],
        tools: Record<string, AISdkTool>,
        options?: {
            temperature?: number;
            maxTokens?: number;
        }
    ): Promise<GenerateTextResult<Record<string, AISdkTool>>> {
        // Don't use throttling for complete() calls - we want the full response immediately
        const model = this.getLanguageModel(messages, false);
        const startTime = Date.now();

        // Convert system messages for Claude Code resume sessions
        let processedMessages = messages;
        if (this.provider === "claudeCode" && this.sessionId) {
            processedMessages = convertSystemMessagesForResume(messages);
        }

        // Add provider-specific cache control
        processedMessages = this.addCacheControl(processedMessages);

        // Log the request
        this.llmLogger
            .logLLMRequest({
                provider: this.provider,
                model: this.model,
                messages,
                tools: Object.keys(tools).map((name) => ({ name })),
                startTime,
            })
            .catch((err) => {
                logger.error("[LLMService] Failed to log request", { error: err });
            });

        try {
            const result = await generateText({
                model,
                messages: processedMessages,
                tools: 'tools' in model && model.tools ? { ...model.tools, ...tools } : tools,
                temperature: options?.temperature ?? this.temperature,
                maxOutputTokens: options?.maxTokens ?? this.maxTokens,

                // ✨ Enable full AI SDK telemetry
                experimental_telemetry: this.getFullTelemetryConfig(),
            });

            // Check for invalid tool calls and mark span as error
            const activeSpan = trace.getActiveSpan();
            if (activeSpan && result.steps) {
                const invalidToolCalls: Array<{ toolName: string; error: string }> = [];

                for (const step of result.steps) {
                    if (step.toolCalls) {
                        for (const toolCall of step.toolCalls) {
                            const tc = toolCall as any;
                            if (tc.dynamic === true && tc.invalid === true && tc.error) {
                                invalidToolCalls.push({
                                    toolName: tc.toolName || 'unknown',
                                    error: tc.error.name || 'Unknown error'
                                });
                            }
                        }
                    }
                }

                if (invalidToolCalls.length > 0) {
                    activeSpan.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: `Invalid tool calls: ${invalidToolCalls.map(tc => tc.toolName).join(', ')}`
                    });
                    activeSpan.setAttribute('error', true);
                    activeSpan.setAttribute('error.type', 'AI_InvalidToolCall');
                    activeSpan.setAttribute('error.invalid_tool_count', invalidToolCalls.length);
                    activeSpan.setAttribute('error.invalid_tools', invalidToolCalls.map(tc => tc.toolName).join(', '));

                    for (const invalidTool of invalidToolCalls) {
                        activeSpan.addEvent('invalid_tool_call', {
                            'tool.name': invalidTool.toolName,
                            'error.type': invalidTool.error
                        });
                    }

                    logger.error("[LLMService] Invalid tool calls detected in complete()", {
                        invalidToolCalls,
                        model: this.model,
                        provider: this.provider
                    });
                }
            }

            // Capture session ID from provider metadata if using Claude Code
            if (this.provider === "claudeCode" && result.providerMetadata?.["claude-code"]?.sessionId) {
                const capturedSessionId = result.providerMetadata["claude-code"].sessionId;
                logger.debug("[LLMService] Captured Claude Code session ID from complete", {
                    sessionId: capturedSessionId,
                    provider: this.provider
                });
                // Emit session ID for storage by the executor
                this.emit("session-captured", { sessionId: capturedSessionId });
            }

            // Log if reasoning was extracted
            if ("reasoning" in result && result.reasoning) {
                logger.debug("[LLMService] Reasoning extracted from response", {
                    reasoningLength: result.reasoning.length,
                    textLength: result.text?.length || 0,
                });
            }

            const duration = Date.now() - startTime;

            // Log the response
            this.llmLogger
                .logLLMResponse({
                    response: {
                        content: result.text,
                        usage: result.usage,
                    },
                    endTime: Date.now(),
                    startTime,
                })
                .catch((err) => {
                    logger.error("[LLMService] Failed to log response", { error: err });
                });

            logger.debug("[LLMService] Complete response received", {
                model: `${this.provider}:${this.model}`,
                duration,
                usage: result.usage,
                toolCallCount: result.toolCalls?.length || 0,
                responseLength: result.text?.length || 0,
            });

            return result;
        } catch (error) {
            const duration = Date.now() - startTime;

            this.llmLogger
                .logLLMResponse({
                    error: error as Error,
                    endTime: Date.now(),
                    startTime,
                })
                .catch((err) => {
                    logger.error("[LLMService] Failed to log error", { error: err });
                });

            logger.error("[LLMService] Complete failed", {
                model: `${this.provider}:${this.model}`,
                duration,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    async stream(
        messages: ModelMessage[],
        tools: Record<string, AISdkTool>,
        options?: {
            abortSignal?: AbortSignal;
            prepareStep?: (step: { messages: ModelMessage[]; stepNumber: number }) => { messages?: ModelMessage[] } | void;
        }
    ): Promise<void> {
        logger.debug("[LLMService] 🚀 STARTING STREAM", {
            provider: this.provider,
            model: this.model,
            messageCount: messages.length,
            messageRoles: messages.map(m => m.role),
            sessionId: this.sessionId || "NONE",
            toolCount: Object.keys(tools).length,
        });

        const model = this.getLanguageModel(messages);

        // Convert system messages for Claude Code resume sessions
        let processedMessages = messages;
        if (this.provider === "claudeCode" && this.sessionId) {
            logger.debug("[LLMService] 🎯 CLAUDE CODE RESUME MODE", {
                sessionId: this.sessionId,
                originalMessageCount: messages.length,
            });
            processedMessages = convertSystemMessagesForResume(messages);
        }

        // Add provider-specific cache control
        processedMessages = this.addCacheControl(processedMessages);

        // Log the request
        this.llmLogger
            .logLLMRequest({
                provider: this.provider,
                model: this.model,
                messages,
                tools: Object.keys(tools).map((name) => ({ name })),
                startTime: Date.now(),
            })
            .catch((err) => {
                logger.error("[LLMService] Failed to log request", { error: err });
            });

        const startTime = Date.now();

        // Don't use throttling for the review model used by ProgressMonitor
        const reviewModel = this.getLanguageModel(undefined, false);
        const progressMonitor = new ProgressMonitor(reviewModel);

        const stopWhen = async ({ steps }: { steps: StepResult<Record<string, AISdkTool>>[] }): Promise<boolean> => {
            const toolNames: string[] = [];
            for (const step of steps) {
                if (step.toolCalls) {
                    for (const tc of step.toolCalls) {
                        toolNames.push(tc.toolName);
                    }
                }
            }
            const shouldContinue = await progressMonitor.check(toolNames);
            return !shouldContinue;
        };

        const { textStream } = streamText({
            model,
            messages: processedMessages,
            tools: 'tools' in model && model.tools ? { ...model.tools, ...tools } : tools,
            temperature: this.temperature,
            maxOutputTokens: this.maxTokens,
            stopWhen,
            prepareStep: options?.prepareStep,
            abortSignal: options?.abortSignal,

            // ✨ Enable full AI SDK telemetry
            experimental_telemetry: this.getFullTelemetryConfig(),

            providerOptions: {
                openrouter: {
                    usage: { include: true },
                },
            },

            onChunk: this.handleChunk.bind(this),
            onFinish: this.createFinishHandler(startTime),
        });

        // Consume the stream (this is what triggers everything!)
        try {
            // CRITICAL: This loop is what actually triggers the stream execution
            for await (const _chunk of textStream) {
                // The onChunk callback should handle all processing
                // We just need to consume the stream to trigger execution
            }
        } catch (error) {
            await this.handleStreamError(error, startTime);
            throw error;
        }
    }

    private handleChunk(event: { chunk: TextStreamPart<Record<string, AISdkTool>> }): void {
        const chunk = event.chunk;

        // Emit chunk-type-change event BEFORE processing the new chunk
        // This allows listeners to flush buffers before new content of a different type arrives
        if (this.previousChunkType !== undefined && this.previousChunkType !== chunk.type) {
            this.emit("chunk-type-change", {
                from: this.previousChunkType,
                to: chunk.type
            });
        }

        // Update previousChunkType AFTER emitting the change event
        this.previousChunkType = chunk.type;

        switch (chunk.type) {
            case "text-delta":
                this.handleTextDelta(chunk.text);
                break;
            case "reasoning-delta": {
                // Handle reasoning-delta separately - emit reasoning event
                // The AI SDK may transform our custom reasoning-delta chunks
                // to use 'text' property instead of 'delta'
                interface ReasoningDeltaChunk {
                    delta?: string;
                    text?: string;
                }
                const reasoningChunk = chunk as ReasoningDeltaChunk;
                const reasoningContent = reasoningChunk.delta || reasoningChunk.text;
                logger.debug("[LLMService] Processing reasoning-delta chunk - DETAILED", {
                    deltaLength: reasoningChunk.delta?.length,
                    textLength: reasoningChunk.text?.length,
                    reasoningContent: reasoningContent?.substring(0, 100),
                    willCallHandleReasoningDelta: !!reasoningContent
                });
                if (reasoningContent) {
                    logger.debug("[LLMService] CALLING handleReasoningDelta NOW", {
                        contentLength: reasoningContent.length
                    });
                    this.handleReasoningDelta(reasoningContent);
                    logger.debug("[LLMService] FINISHED calling handleReasoningDelta");
                } else {
                    logger.error("[LLMService] NO REASONING CONTENT FOUND IN CHUNK", {
                        chunk: JSON.stringify(chunk)
                    });
                }
                break;
            }
            case "tool-call":
                this.handleToolCall(chunk.toolCallId, chunk.toolName, chunk.input);
                break;
            case "tool-result":
                this.handleToolResult(chunk.toolCallId, chunk.toolName, chunk.output);
                break;
            case "tool-input-start":
                // Tool input is starting to stream - we can log but don't need to process
                logger.debug("[LLMService] Tool input starting", {
                    toolCallId: chunk.toolCallId,
                    toolName: chunk.toolName
                });
                break;
            case "tool-input-delta":
                // Tool input is being incrementally streamed - can be used for real-time display
                logger.debug("[LLMService] Tool input delta", {
                    toolCallId: chunk.toolCallId,
                    text: chunk.text
                });
                break;
            case "reasoning-start":
                logger.debug("[LLMService] Reasoning started", {
                    id: chunk.id
                });
                break;
            case "reasoning-end":
                logger.info("[LLMService] Reasoning ended", {
                    id: chunk.id,
                    chunk
                });
                break;
            case "error":
                // Extract detailed error information
                const errorMsg = chunk.error instanceof Error
                    ? chunk.error.message
                    : String(chunk.error);
                const errorStack = chunk.error instanceof Error
                    ? chunk.error.stack
                    : undefined;

                logger.error("[LLMService] ❌ Error chunk received", {
                    errorMessage: errorMsg,
                    errorStack,
                    errorType: chunk.error?.constructor?.name,
                    fullError: chunk.error
                });
                this.emit("stream-error", { error: chunk.error });
                break;
            default:
                // Log unknown chunk types for debugging
                logger.debug("[LLMService] Unknown chunk type", {
                    type: chunk.type,
                    chunk
                });
        }
    }

    private createFinishHandler(startTime: number) {
        return async (
            e: StepResult<Record<string, AISdkTool>> & {
                steps: StepResult<Record<string, AISdkTool>>[];
                totalUsage: LanguageModelUsage;
                providerMetadata: ProviderMetadata;
            }
        ): Promise<void> => {

            try {
                // Check for invalid tool calls and mark span as error
                const activeSpan = trace.getActiveSpan();
                if (activeSpan) {
                    const invalidToolCalls: Array<{ toolName: string; error: string }> = [];

                    for (const step of e.steps) {
                        if (step.toolCalls) {
                            for (const toolCall of step.toolCalls) {
                                // Check if this is a dynamic tool call that's invalid
                                const tc = toolCall as any;
                                if (tc.dynamic === true && tc.invalid === true && tc.error) {
                                    invalidToolCalls.push({
                                        toolName: tc.toolName || 'unknown',
                                        error: tc.error.name || 'Unknown error'
                                    });
                                }
                            }
                        }
                    }

                    if (invalidToolCalls.length > 0) {
                        // Mark span as error
                        activeSpan.setStatus({
                            code: SpanStatusCode.ERROR,
                            message: `Invalid tool calls: ${invalidToolCalls.map(tc => tc.toolName).join(', ')}`
                        });

                        // Add error attributes
                        activeSpan.setAttribute('error', true);
                        activeSpan.setAttribute('error.type', 'AI_InvalidToolCall');
                        activeSpan.setAttribute('error.invalid_tool_count', invalidToolCalls.length);
                        activeSpan.setAttribute('error.invalid_tools', invalidToolCalls.map(tc => tc.toolName).join(', '));

                        // Add span event for each invalid tool
                        for (const invalidTool of invalidToolCalls) {
                            activeSpan.addEvent('invalid_tool_call', {
                                'tool.name': invalidTool.toolName,
                                'error.type': invalidTool.error
                            });
                        }

                        logger.error("[LLMService] Invalid tool calls detected in response", {
                            invalidToolCalls,
                            model: this.model,
                            provider: this.provider
                        });
                    }
                }

                // Cancel any pending content publish timeout for non-streaming providers
                if (this.contentPublishTimeout) {
                    clearTimeout(this.contentPublishTimeout);
                    this.contentPublishTimeout = undefined;
                }

                // Check if provider supports streaming
                const supportsStreaming = isAISdkProvider(this.provider)
                    ? providerSupportsStreaming(this.provider)
                    : true;

                // For non-streaming providers, use cached content; for streaming, use e.text
                const finalMessage = !supportsStreaming && this.cachedContentForComplete
                    ? this.cachedContentForComplete
                    : (e.text || "");

                await this.llmLogger.logLLMResponse({
                    response: {
                        content: e.text,
                        usage: e.totalUsage,
                    },
                    endTime: Date.now(),
                    startTime,
                });

                if (this.provider === "claudeCode" && e.providerMetadata?.["claude-code"]?.sessionId) {
                    const capturedSessionId = e.providerMetadata["claude-code"].sessionId;
                    logger.debug("[LLMService] 🎉 CAPTURED CLAUDE CODE SESSION ID FROM STREAM", {
                        capturedSessionId,
                        previousSessionId: this.sessionId || "NONE",
                        provider: this.provider,
                        sessionChanged: capturedSessionId !== this.sessionId
                    });
                    // Emit session ID for storage by the executor
                    this.emit("session-captured", { sessionId: capturedSessionId });
                } else if (this.provider === "claudeCode") {
                    logger.warn("[LLMService] ⚠️ NO CLAUDE CODE SESSION IN METADATA", {
                        providerMetadata: e.providerMetadata
                    });
                }

                logger.debug("[LLMService] Stream onFinish - emitting complete event", {
                    hasText: !!e.text,
                    textLength: e.text?.length || 0,
                    textPreview: e.text?.substring(0, 100),
                    finishReason: e.finishReason,
                    usingCachedContent: !supportsStreaming && !!this.cachedContentForComplete,
                });

                this.emit("complete", {
                    message: finalMessage,
                    steps: e.steps,
                    usage: {
                        costUsd: e.providerMetadata?.openrouter?.usage?.cost,
                        ...(e.totalUsage || {}),
                    },
                    finishReason: e.finishReason,
                });

                // Clear cached content after use
                this.cachedContentForComplete = "";
            } catch (error) {
                logger.error("[LLMService] Error in onFinish handler", {
                    error: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        };
    }

    private async handleStreamError(error: unknown, startTime: number): Promise<void> {
        const duration = Date.now() - startTime;

        await this.llmLogger
            .logLLMResponse({
                error: error as Error,
                endTime: Date.now(),
                startTime,
            })
            .catch((err) => {
                logger.error("[LLMService] Failed to log error response", { error: err });
            });

        // Format stack trace for better readability
        const stackLines = error instanceof Error && error.stack
            ? error.stack.split("\n").map(line => line.trim()).filter(Boolean)
            : undefined;

        logger.error("[LLMService] Stream failed", {
            model: `${this.provider}:${this.model}`,
            duration,
            error: error instanceof Error ? error.message : String(error),
            stack: stackLines,
        });
    }

    private handleTextDelta(text: string): void {
        // Check if provider supports streaming
        const supportsStreaming = isAISdkProvider(this.provider)
            ? providerSupportsStreaming(this.provider)
            : true;

        if (supportsStreaming) {
            // Streaming providers: emit immediately
            this.emit("content", { delta: text });
        } else {
            // Non-streaming providers: cache content and delay emission
            this.cachedContentForComplete = text;

            // Clear any existing timeout
            if (this.contentPublishTimeout) {
                clearTimeout(this.contentPublishTimeout);
            }

            // Set new timeout to emit after 250ms
            this.contentPublishTimeout = setTimeout(() => {
                this.emit("content", { delta: this.cachedContentForComplete });
            }, 250);
        }
    }

    private handleReasoningDelta(text: string): void {
        logger.debug("[LLMService] INSIDE handleReasoningDelta - ABOUT TO EMIT", {
            deltaLength: text.length,
            preview: text.substring(0, 100),
            hasListeners: this.listenerCount("reasoning"),
            allEventNames: this.eventNames()
        });

        this.emit("reasoning", { delta: text });

        logger.debug("[LLMService] EMITTED reasoning event SUCCESSFULLY");
    }

    private handleToolCall(toolCallId: string, toolName: string, args: unknown): void {
        logger.debug("[LLMService] Emitting tool-will-execute", {
            toolName,
            toolCallId,
            toolCallIdType: typeof toolCallId,
            toolCallIdLength: toolCallId?.length,
        });
        this.emit("tool-will-execute", {
            toolName,
            toolCallId,
            args,
        });
    }

    /**
     * Check if a tool result indicates an error
     * AI SDK wraps tool execution errors in error-text or error-json formats
     */
    private isToolResultError(result: unknown): boolean {
        if (typeof result !== "object" || result === null) {
            return false;
        }
        const res = result as Record<string, unknown>;
        // Check for AI SDK's known error formats
        return (res.type === "error-text" && typeof res.text === "string") ||
               (res.type === "error-json" && typeof res.json === "object");
    }

    /**
     * Extract error details from tool result for better logging
     */
    private extractErrorDetails(result: unknown): { message: string; type: string } | null {
        if (typeof result !== "object" || result === null) {
            return null;
        }
        const res = result as Record<string, unknown>;

        if (res.type === "error-text" && typeof res.text === "string") {
            return { message: res.text, type: "error-text" };
        }

        if (res.type === "error-json" && typeof res.json === "object") {
            const errorJson = res.json as Record<string, unknown>;
            const message = errorJson.message || errorJson.error || JSON.stringify(errorJson);
            return { message: String(message), type: "error-json" };
        }

        return null;
    }

    private handleToolResult(toolCallId: string, toolName: string, result: unknown): void {
        const hasError = this.isToolResultError(result);

        if (hasError) {
            const errorDetails = this.extractErrorDetails(result);
            logger.error(`[LLMService] ❌ Tool '${toolName}' execution failed`, {
                toolCallId,
                toolName,
                errorType: errorDetails?.type || "unknown",
                errorMessage: errorDetails?.message || "No error details available",
                fullResult: result
            });
        } else {
            logger.debug("[LLMService] Emitting tool-did-execute", {
                toolName,
                toolCallId,
                toolCallIdType: typeof toolCallId,
                toolCallIdLength: toolCallId?.length,
            });
        }

        this.emit("tool-did-execute", {
            toolName,
            toolCallId,
            result,
            error: hasError,
        });
    }

    /**
     * Get the language model for use with AI SDK's generateObject and other functions
     */
    getModel(enableThrottling: boolean = false): LanguageModel {
        // Default to no throttling for direct model access
        return this.getLanguageModel(undefined, enableThrottling);
    }

    /**
     * Log generation request
     */
    private async logGenerationRequest(
        messages: ModelMessage[],
        startTime: number
    ): Promise<void> {
        await this.llmLogger.logLLMRequest({
            request: {
                messages,
                model: `${this.provider}:${this.model}`,
            },
            timestamp: startTime,
        });
    }

    /**
     * Log generation response
     */
    private async logGenerationResponse(
        content: string,
        usage: LanguageModelUsage,
        startTime: number
    ): Promise<void> {
        await this.llmLogger.logLLMResponse({
            response: {
                content,
                usage,
            },
            endTime: Date.now(),
            startTime,
        });
    }

    /**
     * Execute object generation and handle logging
     */
    private async executeObjectGeneration<T>(
        languageModel: LanguageModel,
        messages: ModelMessage[],
        schema: z.ZodSchema<T>,
        tools: Record<string, AISdkTool> | undefined
    ): Promise<{ object: T; usage: LanguageModelUsage }> {
        // Merge model.tools with provided tools if model has built-in tools
        const mergedTools = 'tools' in languageModel && languageModel.tools
            ? { ...languageModel.tools, ...(tools || {}) }
            : tools;

        return await generateObject({
            model: languageModel,
            messages,
            schema,
            temperature: this.temperature,
            maxTokens: this.maxTokens,
            ...(mergedTools && Object.keys(mergedTools).length > 0 ? { tools: mergedTools } : {}),

            // ✨ Enable full AI SDK telemetry
            experimental_telemetry: this.getFullTelemetryConfig(),
        });
    }

    /**
     * Generate a structured object using AI SDK's generateObject
     * @param messages - The messages to send to the model
     * @param schema - Zod schema defining the expected structure
     * @param tools - Optional tools for the model to use
     * @returns The generated object matching the schema
     */
    async generateObject<T>(
        messages: ModelMessage[],
        schema: z.ZodSchema<T>,
        tools?: Record<string, AISdkTool>
    ): Promise<{ object: T; usage: LanguageModelUsageWithCostUsd }> {
        const startTime = Date.now();

        return this.withErrorHandling(
            async () => {
                logger.debug("[LLMService] Generating structured object", {
                    provider: this.provider,
                    model: this.model,
                    messagesCount: messages.length
                });

                const languageModel = this.getLanguageModel();
                const result = await this.executeObjectGeneration(
                    languageModel,
                    messages,
                    schema,
                    tools
                );

                const duration = Date.now() - startTime;

                await this.logGenerationRequest(messages, startTime);
                await this.logGenerationResponse(
                    JSON.stringify(result.object),
                    result.usage,
                    startTime
                );

                logger.debug("[LLMService] Structured object generated", {
                    provider: this.provider,
                    model: this.model,
                    duration,
                    usage: result.usage
                });

                return {
                    object: result.object,
                    usage: {
                        ...result.usage,
                        costUsd: this.calculateCostUsd(result.usage)
                    }
                };
            },
            "Generate structured object",
            startTime
        );
    }

    /**
     * Calculate cost in USD for token usage
     * Uses standard pricing tiers based on provider and model
     */
    private calculateCostUsd(usage: LanguageModelUsage): number {
        const promptTokens = usage.promptTokens ?? 0;
        const completionTokens = usage.completionTokens ?? 0;
        
        const costPer1kPrompt = 0.001;
        const costPer1kCompletion = 0.002;
        
        const promptCost = (promptTokens / 1000) * costPer1kPrompt;
        const completionCost = (completionTokens / 1000) * costPer1kCompletion;
        
        return promptCost + completionCost;
    }

    /**
     * Higher-order function for centralized error handling
     */
    private async withErrorHandling<T>(
        operation: () => Promise<T>,
        operationName: string,
        startTime: number
    ): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            const duration = Date.now() - startTime;
            logger.error(`[LLMService] ${operationName} failed`, {
                provider: this.provider,
                model: this.model,
                duration,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

}
