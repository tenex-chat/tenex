import { ProgressMonitor } from "@/agents/execution/ProgressMonitor";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
    type GenerateTextResult,
    type LanguageModel,
    type LanguageModelMiddleware,
    type LanguageModelUsage,
    type ProviderRegistryProvider,
    type StepResult,
    type StreamTextOnFinishCallback,
    type TelemetrySettings,
    type TextStreamPart,
    extractReasoningMiddleware,
    generateObject,
    generateText,
    smoothStream,
    streamText,
    wrapLanguageModel,
} from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { createFlightRecorderMiddleware } from "./middleware/flight-recorder";
import type { ModelMessage } from "ai";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { EventEmitter } from "tseep";
import type { z } from "zod";
import { shouldIgnoreChunk } from "./chunk-validators";
import { providerSupportsStreaming } from "./provider-configs";
import { isAISdkProvider } from "./type-guards";
import type { LanguageModelUsageWithCostUsd } from "./types";
import {
    compileMessagesForClaudeCode,
    convertSystemMessagesForResume,
} from "./utils/claudeCodePromptCompiler";

/**
 * Content delta event
 */
export interface ContentEvent {
    delta: string;
}

/**
 * Chunk type change event
 */
export interface ChunkTypeChangeEvent {
    from: string | undefined;
    to: string;
}

/**
 * Tool will execute event
 */
export interface ToolWillExecuteEvent {
    toolName: string;
    toolCallId: string;
    args: unknown;
}

/**
 * Tool did execute event
 */
export interface ToolDidExecuteEvent {
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
    reasoning?: string;
}

/**
 * Stream error event
 */
export interface StreamErrorEvent {
    error: unknown;
}

/**
 * Session captured event
 */
export interface SessionCapturedEvent {
    sessionId: string;
}

/**
 * Reasoning delta event
 */
export interface ReasoningEvent {
    delta: string;
}

/**
 * LLM Service for runtime execution with AI SDK providers
 * Pure runtime concerns - no configuration management
 */
export class LLMService extends EventEmitter<Record<string, any>> {
    public readonly provider: string;
    public readonly model: string;
    private readonly temperature?: number;
    private readonly maxTokens?: number;
    private previousChunkType?: string;
    private readonly claudeCodeProviderFunction?: (
        model: string,
        options?: ClaudeCodeSettings
    ) => LanguageModel;
    private readonly sessionId?: string;
    private readonly agentSlug?: string;
    private contentPublishTimeout?: NodeJS.Timeout;
    private cachedContentForComplete = "";

    constructor(
        private readonly registry: ProviderRegistryProvider<any, any> | null,
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
            throw new Error(
                "LLMService requires either a registry or Claude Code provider function"
            );
        }
    }

    /**
     * Get full telemetry configuration for AI SDK
     * Captures EVERYTHING for debugging - no privacy filters
     */
    private getFullTelemetryConfig(): TelemetrySettings {
        return {
            isEnabled: true,
            functionId: `${this.agentSlug || "unknown"}.${this.provider}.${this.model}`,

            // Metadata for debugging context
            metadata: {
                "agent.slug": this.agentSlug || "unknown",
                "llm.provider": this.provider,
                "llm.model": this.model,
                "llm.temperature": this.temperature ?? 0,
                "llm.max_tokens": this.maxTokens ?? 0,
                "session.id": this.sessionId ?? "unknown",
            },

            // FULL DATA - no privacy filters for debugging
            recordInputs: true, // Capture full prompts
            recordOutputs: true, // Capture full responses
        };
    }

    /**
     * Get a language model instance.
     * For Claude Code: Creates model with system prompt from messages.
     * For standard providers: Gets model from registry.
     * Wraps all models with extract-reasoning-middleware.
     */
    private getLanguageModel(messages?: ModelMessage[]): LanguageModel {
        let baseModel: LanguageModel;

        if (this.claudeCodeProviderFunction) {
            // Claude Code provider
            const options: ClaudeCodeSettings = {};

            if (this.sessionId) {
                // When resuming, only pass the resume option
                options.resume = this.sessionId;
            } else if (messages) {
                // When NOT resuming, compile all messages
                const { customSystemPrompt, appendSystemPrompt } =
                    compileMessagesForClaudeCode(messages);

                options.customSystemPrompt = customSystemPrompt;
                if (appendSystemPrompt) {
                    options.appendSystemPrompt = appendSystemPrompt;
                }
            }

            baseModel = this.claudeCodeProviderFunction(this.model, options);
        } else if (this.registry) {
            // Standard providers use registry
            baseModel = this.registry.languageModel(`${this.provider}:${this.model}`);
        } else {
            throw new Error("No provider available for model creation");
        }

        // Build middleware chain
        const middlewares: LanguageModelMiddleware[] = [];

        // AI SDK DevTools - captures LLM interactions for debugging
        // View at http://localhost:4983 after running: npx @ai-sdk/devtools
        middlewares.push(devToolsMiddleware() as LanguageModelMiddleware);

        // Flight recorder - records LLM interactions when enabled via 'r' key
        middlewares.push(createFlightRecorderMiddleware());

        // Extract reasoning from thinking tags
        middlewares.push(
            extractReasoningMiddleware({
                tagName: "thinking",
                separator: "\n",
                startWithReasoning: false,
            })
        );

        // Wrap with middlewares
        // Note: Type assertion needed because AI SDK v6 beta uses LanguageModelV3 internally
        // but stable providers export LanguageModel (union type). This is a beta compatibility issue.
        const wrappedModel = wrapLanguageModel({
            model: baseModel as Parameters<typeof wrapLanguageModel>[0]["model"],
            middleware: middlewares,
        });

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
                            cacheControl: { type: "ephemeral" },
                        },
                    },
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
    ): Promise<GenerateTextResult<Record<string, AISdkTool>, any>> {
        const model = this.getLanguageModel(messages);
        const startTime = Date.now();

        // Convert system messages for Claude Code resume sessions
        let processedMessages = messages;
        if (this.provider === "claudeCode" && this.sessionId) {
            processedMessages = convertSystemMessagesForResume(messages);
        }

        // Add provider-specific cache control
        processedMessages = this.addCacheControl(processedMessages);

        try {
            const result = await generateText({
                model,
                messages: processedMessages,
                tools,
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
                            // Check if this is a dynamic tool call that's invalid
                            if (
                                "dynamic" in toolCall &&
                                toolCall.dynamic === true &&
                                toolCall.invalid === true &&
                                toolCall.error
                            ) {
                                const error =
                                    typeof toolCall.error === "object" &&
                                    toolCall.error !== null &&
                                    "name" in toolCall.error
                                        ? (toolCall.error as { name: string }).name
                                        : "Unknown error";
                                invalidToolCalls.push({
                                    toolName: toolCall.toolName,
                                    error,
                                });
                            }
                        }
                    }
                }

                if (invalidToolCalls.length > 0) {
                    activeSpan.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: `Invalid tool calls: ${invalidToolCalls.map((tc) => tc.toolName).join(", ")}`,
                    });
                    activeSpan.setAttribute("error", true);
                    activeSpan.setAttribute("error.type", "AI_InvalidToolCall");
                    activeSpan.setAttribute("error.invalid_tool_count", invalidToolCalls.length);
                    activeSpan.setAttribute(
                        "error.invalid_tools",
                        invalidToolCalls.map((tc) => tc.toolName).join(", ")
                    );

                    for (const invalidTool of invalidToolCalls) {
                        activeSpan.addEvent("invalid_tool_call", {
                            "tool.name": invalidTool.toolName,
                            "error.type": invalidTool.error,
                        });
                    }

                    logger.error("[LLMService] Invalid tool calls detected in complete()", {
                        invalidToolCalls,
                        model: this.model,
                        provider: this.provider,
                    });
                }
            }

            // Capture session ID from provider metadata if using Claude Code
            if (
                this.provider === "claudeCode" &&
                result.providerMetadata?.["claude-code"]?.sessionId
            ) {
                const capturedSessionId = result.providerMetadata["claude-code"].sessionId as string;
                trace.getActiveSpan()?.addEvent("llm.session_captured", {
                    "session.id": capturedSessionId,
                });
                // Emit session ID for storage by the executor
                this.emit("session-captured", { sessionId: capturedSessionId });
            }

            // Record if reasoning was extracted
            if ("reasoning" in result && result.reasoning) {
                trace.getActiveSpan()?.addEvent("llm.reasoning_extracted", {
                    "reasoning.length": result.reasoning.length,
                    "text.length": result.text?.length || 0,
                });
            }

            const duration = Date.now() - startTime;

            trace.getActiveSpan()?.addEvent("llm.complete_response", {
                "llm.model": `${this.provider}:${this.model}`,
                "llm.duration_ms": duration,
                "llm.tool_call_count": result.toolCalls?.length || 0,
                "llm.response_length": result.text?.length || 0,
            });

            return result;
        } catch (error) {
            const duration = Date.now() - startTime;

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
            prepareStep?: (step: {
                messages: ModelMessage[];
                stepNumber: number;
                steps: StepResult<Record<string, AISdkTool>>[];
            }) =>
                | {
                      messages?: ModelMessage[];
                  }
                | undefined;
            /** Custom stopWhen callback that wraps the default progress monitor check */
            onStopCheck?: (steps: StepResult<Record<string, AISdkTool>>[]) => Promise<boolean>;
        }
    ): Promise<void> {
        const model = this.getLanguageModel(messages);

        // Convert system messages for Claude Code resume sessions
        let processedMessages = messages;
        if (this.provider === "claudeCode" && this.sessionId) {
            processedMessages = convertSystemMessagesForResume(messages);
        }

        // Add provider-specific cache control
        processedMessages = this.addCacheControl(processedMessages);

        const startTime = Date.now();

        const reviewModel = this.getLanguageModel();
        const progressMonitor = new ProgressMonitor(reviewModel);

        const stopWhen = async ({
            steps,
        }: { steps: StepResult<Record<string, AISdkTool>>[] }): Promise<boolean> => {
            // First check custom stop condition (e.g., pair mode check-in)
            if (options?.onStopCheck) {
                const shouldStop = await options.onStopCheck(steps);
                if (shouldStop) {
                    return true;
                }
            }

            // Then check default progress monitor
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
            // Don't pass tools for claudeCode - it has its own built-in tools that conflict
            ...(this.provider !== "claudeCode" && { tools }),
            temperature: this.temperature,
            maxOutputTokens: this.maxTokens,
            stopWhen,
            prepareStep: options?.prepareStep,
            abortSignal: options?.abortSignal,

            // ✨ Enable full AI SDK telemetry
            experimental_telemetry: this.getFullTelemetryConfig(),

            // Smooth streaming with 15ms delay and line-based chunking
            experimental_transform: smoothStream({
                delayInMs: 15,
                chunking: "line"
            }),

            providerOptions: {
                openrouter: {
                    usage: { include: true },
                },
            },

            onChunk: this.handleChunk.bind(this),
            onFinish: this.createFinishHandler(),
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

        // Validate chunk before any processing - some LLMs send chunks that should be ignored
        if (shouldIgnoreChunk(chunk)) {
            return;
        }

        // Emit chunk-type-change event BEFORE processing the new chunk
        // This allows listeners to flush buffers before new content of a different type arrives
        if (this.previousChunkType !== undefined && this.previousChunkType !== chunk.type) {
            this.emit("chunk-type-change", {
                from: this.previousChunkType,
                to: chunk.type,
            });
            this.cachedContentForComplete = "";
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
                if (reasoningContent) {
                    this.handleReasoningDelta(reasoningContent);
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
                // Tool input is starting to stream
                trace.getActiveSpan()?.addEvent("llm.tool_input_start", {
                    "tool.call_id": chunk.id,
                    "tool.name": chunk.toolName,
                });
                break;
            case "tool-input-delta":
                // Tool input is being incrementally streamed - too verbose for traces
                break;
            case "reasoning-start":
                trace.getActiveSpan()?.addEvent("llm.reasoning_start", {
                    "reasoning.id": chunk.id,
                });
                break;
            case "reasoning-end":
                trace.getActiveSpan()?.addEvent("llm.reasoning_end", {
                    "reasoning.id": chunk.id,
                });
                break;
            case "error": {
                // Extract detailed error information
                const errorMsg =
                    chunk.error instanceof Error ? chunk.error.message : String(chunk.error);
                const errorStack = chunk.error instanceof Error ? chunk.error.stack : undefined;

                logger.error("[LLMService] ❌ Error chunk received", {
                    errorMessage: errorMsg,
                    errorStack,
                    errorType: chunk.error?.constructor?.name,
                    fullError: chunk.error,
                });
                this.emit("stream-error", { error: chunk.error });
                break;
            }
            default:
                // Record unknown chunk types for debugging
                trace.getActiveSpan()?.addEvent("llm.unknown_chunk_type", {
                    "chunk.type": chunk.type,
                });
        }
    }

    private createFinishHandler(): StreamTextOnFinishCallback<Record<string, AISdkTool>> {
        return async (e) => {
            try {
                // Check for invalid tool calls and mark span as error
                const activeSpan = trace.getActiveSpan();
                if (activeSpan) {
                    const invalidToolCalls: Array<{ toolName: string; error: string }> = [];

                    for (const step of e.steps) {
                        if (step.toolCalls) {
                            for (const toolCall of step.toolCalls) {
                                // Check if this is a dynamic tool call that's invalid
                                if (
                                    "dynamic" in toolCall &&
                                    toolCall.dynamic === true &&
                                    toolCall.invalid === true &&
                                    toolCall.error
                                ) {
                                    const error =
                                        typeof toolCall.error === "object" &&
                                        toolCall.error !== null &&
                                        "name" in toolCall.error
                                            ? (toolCall.error as { name: string }).name
                                            : "Unknown error";
                                    invalidToolCalls.push({
                                        toolName: toolCall.toolName,
                                        error,
                                    });
                                }
                            }
                        }
                    }

                    if (invalidToolCalls.length > 0) {
                        // Mark span as error
                        activeSpan.setStatus({
                            code: SpanStatusCode.ERROR,
                            message: `Invalid tool calls: ${invalidToolCalls.map((tc) => tc.toolName).join(", ")}`,
                        });

                        // Add error attributes
                        activeSpan.setAttribute("error", true);
                        activeSpan.setAttribute("error.type", "AI_InvalidToolCall");
                        activeSpan.setAttribute(
                            "error.invalid_tool_count",
                            invalidToolCalls.length
                        );
                        activeSpan.setAttribute(
                            "error.invalid_tools",
                            invalidToolCalls.map((tc) => tc.toolName).join(", ")
                        );

                        // Add span event for each invalid tool
                        for (const invalidTool of invalidToolCalls) {
                            activeSpan.addEvent("invalid_tool_call", {
                                "tool.name": invalidTool.toolName,
                                "error.type": invalidTool.error,
                            });
                        }

                        logger.error("[LLMService] Invalid tool calls detected in response", {
                            invalidToolCalls,
                            model: this.model,
                            provider: this.provider,
                        });
                    }
                }

                // Cancel any pending content publish timeout for non-streaming providers
                if (this.contentPublishTimeout) {
                    clearTimeout(this.contentPublishTimeout);
                    this.contentPublishTimeout = undefined;
                }

                // For non-streaming providers, use cached content; for streaming, use e.text
                const finalMessage =
                    this.cachedContentForComplete
                        ? this.cachedContentForComplete
                        : e.text || "";

                if (
                    this.provider === "claudeCode" &&
                    e.providerMetadata?.["claude-code"]?.sessionId
                ) {
                    const capturedSessionId = e.providerMetadata["claude-code"].sessionId as string;
                    // Emit session ID for storage by the executor
                    this.emit("session-captured", { sessionId: capturedSessionId });
                }

                // Extract OpenRouter-specific usage data
                const openrouterUsage = (e.providerMetadata?.openrouter as {
                    usage?: {
                        cost?: number;
                        promptTokensDetails?: { cachedTokens?: number };
                        completionTokensDetails?: { reasoningTokens?: number };
                    };
                })?.usage;

                this.emit("complete", {
                    message: finalMessage,
                    steps: e.steps,
                    usage: {
                        ...(e.totalUsage || {}),
                        costUsd: openrouterUsage?.cost,
                        cachedInputTokens: openrouterUsage?.promptTokensDetails?.cachedTokens,
                        reasoningTokens: openrouterUsage?.completionTokensDetails?.reasoningTokens,
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

        // Format stack trace for better readability
        const stackLines =
            error instanceof Error && error.stack
                ? error.stack
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean)
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
            this.cachedContentForComplete += text;
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
        // Skip useless "[REDACTED]" reasoning events
        if (text.trim() === "[REDACTED]") {
            return;
        }
        this.emit("reasoning", { delta: text });
    }

    private handleToolCall(toolCallId: string, toolName: string, args: unknown): void {
        trace.getActiveSpan()?.addEvent("llm.tool_will_execute", {
            "tool.name": toolName,
            "tool.call_id": toolCallId,
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
        return (
            (res.type === "error-text" && typeof res.text === "string") ||
            (res.type === "error-json" && typeof res.json === "object")
        );
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
            logger.error(`[LLMService] Tool '${toolName}' execution failed`, {
                toolCallId,
                toolName,
                errorType: errorDetails?.type || "unknown",
                errorMessage: errorDetails?.message || "No error details available",
            });
        }

        trace.getActiveSpan()?.addEvent("llm.tool_did_execute", {
            "tool.name": toolName,
            "tool.call_id": toolCallId,
            "tool.error": hasError,
        });

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
    getModel(): LanguageModel {
        return this.getLanguageModel();
    }

    /**
     * Execute object generation
     */
    private async executeObjectGeneration<T>(
        languageModel: LanguageModel,
        messages: ModelMessage[],
        schema: z.ZodSchema<T>,
        tools: Record<string, AISdkTool> | undefined
    ): Promise<{ object: T; usage: LanguageModelUsage }> {
        return await generateObject({
            model: languageModel,
            messages,
            schema,
            temperature: this.temperature,
            maxTokens: this.maxTokens,
            ...(tools && Object.keys(tools).length > 0 ? { tools } : {}),

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
                trace.getActiveSpan()?.addEvent("llm.generate_object_start", {
                    "llm.provider": this.provider,
                    "llm.model": this.model,
                    "messages.count": messages.length,
                });

                const languageModel = this.getLanguageModel();
                const result = await this.executeObjectGeneration(
                    languageModel,
                    messages,
                    schema,
                    tools
                );

                const duration = Date.now() - startTime;

                trace.getActiveSpan()?.addEvent("llm.generate_object_complete", {
                    "llm.provider": this.provider,
                    "llm.model": this.model,
                    "llm.duration_ms": duration,
                });

                return {
                    object: result.object,
                    usage: {
                        ...result.usage,
                        costUsd: this.calculateCostUsd(result.usage),
                    },
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
        const promptTokens = usage.inputTokens ?? 0;
        const completionTokens = usage.outputTokens ?? 0;

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
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
}
