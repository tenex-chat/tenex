import { ProgressMonitor } from "@/agents/execution/ProgressMonitor";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
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
    streamText,
    wrapLanguageModel,
} from "ai";
import type { ModelMessage } from "ai";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { EventEmitter } from "tseep";
import type { z } from "zod";
import { shouldIgnoreChunk } from "./chunk-validators";
import { createFlightRecorderMiddleware } from "./middleware/flight-recorder";
import { PROVIDER_IDS } from "./providers/provider-ids";
import type { ProviderCapabilities } from "./providers/types";
import type { LanguageModelUsageWithCostUsd } from "./types";
import { getContextWindow, resolveContextWindow } from "./utils/context-window-cache";
import { getInvalidToolCalls, isToolResultError, extractErrorDetails } from "./utils/tool-errors";
import { calculateCumulativeUsage } from "./utils/usage";
import { extractUsageMetadata, extractOpenRouterGenerationId } from "./providers/usage-metadata";

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
    /** Cumulative usage from previous steps (if available) */
    usage?: LanguageModelUsageWithCostUsd;
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
 * Raw chunk event - emitted for every valid chunk from the AI SDK stream
 * Allows consumers to process raw chunks without LLMService knowing about their use case
 */
export interface RawChunkEvent {
    chunk: TextStreamPart<Record<string, AISdkTool>>;
}

/**
 * LLM Service for runtime execution with AI SDK providers
 * Pure runtime concerns - no configuration management
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class LLMService extends EventEmitter<Record<string, any>> {
    public readonly provider: string;
    public readonly model: string;
    private readonly capabilities: ProviderCapabilities;
    private readonly temperature?: number;
    private readonly maxTokens?: number;
    private previousChunkType?: string;
    private readonly claudeCodeProviderFunction?: (
        model: string,
        options?: ClaudeCodeSettings
    ) => LanguageModel;
    private readonly claudeCodeBaseSettings?: ClaudeCodeSettings;
    private readonly sessionId?: string;
    private readonly agentSlug?: string;
    private readonly conversationId?: string;
    private cachedContentForComplete = "";
    /** Cumulative usage from previous steps, set via setCurrentStepUsage */
    private currentStepUsage?: LanguageModelUsageWithCostUsd;
    /** Last user message - stored before streaming for logging in onFinish */
    private lastUserMessage?: string;

    constructor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        private readonly registry: ProviderRegistryProvider<any, any> | null,
        provider: string,
        model: string,
        capabilities: ProviderCapabilities,
        temperature?: number,
        maxTokens?: number,
        claudeCodeProviderFunction?: (model: string, options?: ClaudeCodeSettings) => LanguageModel,
        claudeCodeBaseSettings?: ClaudeCodeSettings,
        sessionId?: string,
        agentSlug?: string,
        conversationId?: string
    ) {
        super();
        this.provider = provider;
        this.model = model;
        this.capabilities = capabilities;
        this.temperature = temperature;
        this.maxTokens = maxTokens;
        this.claudeCodeProviderFunction = claudeCodeProviderFunction;
        this.claudeCodeBaseSettings = claudeCodeBaseSettings;
        this.sessionId = sessionId;
        this.agentSlug = agentSlug;
        this.conversationId = conversationId;

        if (!registry && !claudeCodeProviderFunction) {
            throw new Error(
                "LLMService requires either a registry or Claude Code provider function"
            );
        }

        // Fire-and-forget: start resolving context window
        resolveContextWindow(this.provider, this.model).catch(() => {
            // Silently ignore - context window will be undefined if fetch fails
        });
    }

    /**
     * Get trace correlation ID for OpenRouter.
     * Returns a string combining trace and span IDs for unique request identification.
     */
    private getTraceCorrelationId(): string | undefined {
        const span = trace.getActiveSpan();
        if (!span) return undefined;
        const ctx = span.spanContext();
        return `tenex-${ctx.traceId}-${ctx.spanId}`;
    }

    /**
     * Get OpenRouter metadata for request correlation.
     * Includes OTL trace context plus agent and conversation identifiers.
     */
    private getOpenRouterMetadata(): Record<string, string> {
        const metadata: Record<string, string> = {};

        const span = trace.getActiveSpan();
        if (span) {
            const ctx = span.spanContext();
            metadata.tenex_trace_id = ctx.traceId;
            metadata.tenex_span_id = ctx.spanId;
        }

        if (this.agentSlug) metadata.tenex_agent = this.agentSlug;
        if (this.conversationId) metadata.tenex_conversation = this.conversationId;

        return metadata;
    }

    /**
     * Update cumulative usage from completed steps.
     * Called from prepareStep to make usage available for tool-will-execute events.
     * Extracts accurate usage from providerMetadata.openrouter.usage when available.
     */
    updateUsageFromSteps(steps: Array<{ usage?: { inputTokens?: number; outputTokens?: number } }>): void {
        this.currentStepUsage = calculateCumulativeUsage(steps);
    }

    /**
     * Get cumulative usage from previous completed steps.
     * Returns undefined if no steps have completed yet.
     */
    getCurrentStepUsage(): LanguageModelUsageWithCostUsd | undefined {
        return this.currentStepUsage;
    }

    /**
     * Get context window for current model
     */
    getModelContextWindow(): number | undefined {
        return getContextWindow(this.provider, this.model);
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
            // Claude Code or Codex CLI provider
            // Start with base settings (cwd, env, mcpServers, etc.) from createAgentSettings
            const options: ClaudeCodeSettings = { ...this.claudeCodeBaseSettings };

            // Extract system messages and pass as plain string systemPrompt for Claude Code
            // Using plain string (not preset+append) gives full control over agent identity
            if (messages && this.provider === PROVIDER_IDS.CLAUDE_CODE) {
                const systemContent = messages
                    .filter((m) => m.role === "system")
                    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
                    .join("\n\n");

                if (systemContent) {
                    options.systemPrompt = systemContent;
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

    private prepareMessagesForRequest(messages: ModelMessage[]): ModelMessage[] {
        let processedMessages = messages;

        // For Claude Code, filter out system messages since they're passed via systemPrompt
        if (this.provider === PROVIDER_IDS.CLAUDE_CODE) {
            processedMessages = messages.filter((m) => m.role !== "system");
        }

        return this.addCacheControl(processedMessages);
    }

    private recordInvalidToolCalls(
        steps: StepResult<Record<string, AISdkTool>>[],
        logContext: "complete" | "response"
    ): void {
        const activeSpan = trace.getActiveSpan();
        if (!activeSpan) {
            return;
        }

        const invalidToolCalls = getInvalidToolCalls(steps);
        if (invalidToolCalls.length === 0) {
            return;
        }

        const logSuffix = logContext === "complete" ? "complete()" : "response";

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

        logger.error(`[LLMService] Invalid tool calls detected in ${logSuffix}`, {
            invalidToolCalls,
            model: this.model,
            provider: this.provider,
        });
    }

    private emitSessionCapturedFromMetadata(
        providerMetadata: Record<string, unknown> | undefined,
        recordSpanEvent: boolean
    ): void {
        if (this.provider === PROVIDER_IDS.CODEX_APP_SERVER) {
            const sessionId = (
                providerMetadata?.[PROVIDER_IDS.CODEX_APP_SERVER] as { sessionId?: string } | undefined
            )?.sessionId;
            if (sessionId) {
                if (recordSpanEvent) {
                    trace.getActiveSpan()?.addEvent("llm.session_captured", {
                        "session.id": sessionId,
                    });
                }
                this.emit("session-captured", { sessionId });
            }
        }
    }

    /**
     * Extract the last user message text from a message array.
     * Handles both simple string content and complex content arrays.
     */
    private extractLastUserMessage(messages: ModelMessage[]): string | undefined {
        // Find the last message with role "user" (iterate from end)
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role === "user") {
                // User messages can have string content or content array
                if (typeof msg.content === "string") {
                    return msg.content;
                }
                if (Array.isArray(msg.content)) {
                    // Extract text from content parts
                    const textParts = msg.content
                        .filter((part): part is { type: "text"; text: string } =>
                            part.type === "text" && typeof part.text === "string"
                        )
                        .map((part) => part.text);
                    if (textParts.length > 0) {
                        return textParts.join("\n");
                    }
                }
                // Found user message but couldn't extract text
                return "[User message with non-text content]";
            }
        }
        return undefined;
    }

    /**
     * Result type for prepareStep, matching AI SDK v6's PrepareStepResult.
     * Allows dynamic model switching, tool control, and message overrides per step.
     */
    // NOTE: The full AI SDK PrepareStepResult includes: model, toolChoice, activeTools,
    // system, messages, experimental_context, providerOptions. We expose what we need.

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
                | PromiseLike<{ model?: LanguageModel; messages?: ModelMessage[] } | undefined>
                | { model?: LanguageModel; messages?: ModelMessage[] }
                | undefined;
            /** Custom stopWhen callback that wraps the default progress monitor check */
            onStopCheck?: (steps: StepResult<Record<string, AISdkTool>>[]) => Promise<boolean>;
        }
    ): Promise<void> {
        const model = this.getLanguageModel(messages);

        const processedMessages = this.prepareMessagesForRequest(messages);

        // Extract last user message for logging - find the last message with role "user"
        // and extract its text content
        this.lastUserMessage = this.extractLastUserMessage(messages);

        const startTime = Date.now();

        // ProgressMonitor is only used for providers without built-in tools
        // Providers with built-in tools handle their own progress/session management
        let progressMonitor: ProgressMonitor | undefined;
        if (!this.capabilities.builtInTools) {
            const reviewModel = this.getLanguageModel();
            progressMonitor = new ProgressMonitor(reviewModel);
        }

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

            // Then check default progress monitor (only for standard providers)
            if (progressMonitor) {
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
            }

            return false;
        };

        const { fullStream } = streamText({
            model,
            messages: processedMessages,
            // Don't pass tools for providers with built-in tools - they have their own that would conflict
            ...(!this.capabilities.builtInTools && { tools }),
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
                    user: this.getTraceCorrelationId(),
                    metadata: this.getOpenRouterMetadata(),
                },
            },

            onChunk: this.handleChunk.bind(this),
            onFinish: this.createFinishHandler(),
            onError: ({ error }) => {
                // Emit stream-error event for the executor to handle and publish to user
                this.emit("stream-error", { error });
            },
        });

        // Consume the stream (this is what triggers everything!)
        // In AI SDK v6, the stream's flush() handler awaits onFinish before closing,
        // so the for-await loop should complete AFTER onFinish has run.
        //
        // IMPORTANT: We use fullStream instead of textStream because:
        // - textStream only yields text deltas
        // - fullStream yields ALL events including tool-error
        // - tool-error events are NOT delivered to onChunk callback
        // - Without fullStream, failed tool executions are never recorded
        try {
            // CRITICAL: This loop is what actually triggers the stream execution
            // We iterate fullStream to catch tool-error events that onChunk misses
            for await (const part of fullStream) {
                // Handle tool-error events that don't come through onChunk
                // The onChunk callback handles most events, but tool-error only comes through fullStream
                if (part.type === "tool-error") {
                    this.handleChunk({ chunk: part as TextStreamPart<Record<string, AISdkTool>> });
                }
                // Other events are handled by onChunk callback
            }

            // DIAGNOSTIC: Track when for-await loop completes
            // At this point, onFinish SHOULD have already run (AI SDK v6 behavior)
            const loopCompleteTime = Date.now();
            const loopDuration = loopCompleteTime - startTime;
            trace.getActiveSpan()?.addEvent("llm.stream_loop_complete", {
                "stream.loop_complete_time": loopCompleteTime,
                "stream.loop_duration_ms": loopDuration,
                "stream.cached_content_length": this.cachedContentForComplete.length,
            });
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

        // Emit raw-chunk event for consumers (e.g., local streaming)
        logger.debug("[LLMService] emitting raw-chunk", { chunkType: chunk.type });
        this.emit("raw-chunk", { chunk: event.chunk });

        // Emit chunk-type-change event BEFORE processing the new chunk
        // This allows listeners to flush buffers before new content of a different type arrives
        if (this.previousChunkType !== undefined && this.previousChunkType !== chunk.type) {
            this.emit("chunk-type-change", {
                from: this.previousChunkType,
                to: chunk.type,
            });
            // Clear cached content after emitting chunk-type-change.
            // IMPORTANT: AgentExecutor listens to chunk-type-change and publishes the content
            // buffer as a kind:1 event BEFORE this clearing happens. Without that publish,
            // interim text (e.g., "I'll fetch that naddr...") would be lost.
            // See: src/agents/execution/AgentExecutor.ts chunk-type-change handler
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
            case "tool-error": {
                // Handle tool execution errors - emit as tool-did-execute with error flag
                const errorMsg =
                    chunk.error instanceof Error ? chunk.error.message : String(chunk.error);
                const errorStack = chunk.error instanceof Error ? chunk.error.stack : undefined;

                logger.error(`[LLMService] Tool '${chunk.toolName}' threw an error`, {
                    toolCallId: chunk.toolCallId,
                    toolName: chunk.toolName,
                    error: errorMsg,
                    stack: errorStack,
                });

                // Log BOTH error event AND execution complete event for consistency
                const activeSpan = trace.getActiveSpan();
                activeSpan?.addEvent("llm.tool_error", {
                    "tool.name": chunk.toolName,
                    "tool.call_id": chunk.toolCallId,
                    "tool.error_message": errorMsg,
                    "tool.error_type": chunk.error?.constructor?.name || "Error",
                });

                // IMPORTANT: Also log tool_did_execute for error cases
                // This ensures trace analysis can find tool completion regardless of success/failure
                activeSpan?.addEvent("llm.tool_did_execute", {
                    "tool.name": chunk.toolName,
                    "tool.call_id": chunk.toolCallId,
                    "tool.error": true,
                    "tool.error_message": errorMsg.substring(0, 200),
                });

                // Emit tool-did-execute with error info so it gets persisted to conversation
                // Format the error as a result object that the LLM can understand
                this.emit("tool-did-execute", {
                    toolName: chunk.toolName,
                    toolCallId: chunk.toolCallId,
                    result: {
                        type: "error-text",
                        text: `Tool execution failed: ${errorMsg}`,
                    },
                    error: true,
                });
                break;
            }
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
            const onFinishStartTime = Date.now();
            const activeSpan = trace.getActiveSpan();

            // DIAGNOSTIC: Track onFinish lifecycle for debugging race conditions
            activeSpan?.addEvent("llm.onFinish_started", {
                "onFinish.start_time": onFinishStartTime,
                "onFinish.finish_reason": e.finishReason,
                "onFinish.steps_count": e.steps.length,
                "onFinish.text_length": e.text?.length ?? 0,
                "onFinish.cached_content_length": this.cachedContentForComplete.length,
            });

            try {
                this.recordInvalidToolCalls(e.steps, "response");

                // For streaming, use cached content only. Don't fall back to e.text.
                // When cachedContentForComplete is empty, it means all content was already
                // published via chunk-type-change events (interim text before tool calls).
                // Falling back to e.text would cause duplicate publishing.
                const finalMessage = this.cachedContentForComplete;

                this.emitSessionCapturedFromMetadata(
                    e.providerMetadata as Record<string, unknown> | undefined,
                    false
                );

                // Capture OpenRouter generation ID for trace correlation
                const openrouterGenerationId = extractOpenRouterGenerationId(
                    e.providerMetadata as Record<string, unknown> | undefined
                );
                if (openrouterGenerationId) {
                    activeSpan?.setAttribute("openrouter.generation_id", openrouterGenerationId);
                }

                // Extract usage metadata using provider-specific extractor
                const usage = extractUsageMetadata(
                    this.provider,
                    this.model,
                    e.totalUsage,
                    e.providerMetadata as Record<string, unknown> | undefined
                );

                // DIAGNOSTIC: Log right before emitting complete event
                const beforeEmitTime = Date.now();
                activeSpan?.addEvent("llm.complete_will_emit", {
                    "complete.message_length": finalMessage.length,
                    "complete.usage_input_tokens": usage.inputTokens,
                    "complete.usage_output_tokens": usage.outputTokens,
                    "complete.finish_reason": e.finishReason,
                    "complete.ms_since_onFinish_start": beforeEmitTime - onFinishStartTime,
                });

                this.emit("complete", {
                    message: finalMessage,
                    steps: e.steps,
                    usage: {
                        ...usage,
                        contextWindow: this.getModelContextWindow(),
                    },
                    finishReason: e.finishReason,
                });

                // DIAGNOSTIC: Log after emitting complete event
                const afterEmitTime = Date.now();
                activeSpan?.addEvent("llm.complete_did_emit", {
                    "complete.emit_duration_ms": afterEmitTime - beforeEmitTime,
                    "complete.total_onFinish_duration_ms": afterEmitTime - onFinishStartTime,
                });

                // Log the user prompt so we can see what the LLM was answering to
                if (this.lastUserMessage) {
                    const truncatedPrompt = this.lastUserMessage.length > 2000
                        ? this.lastUserMessage.substring(0, 2000) + "... [truncated]"
                        : this.lastUserMessage;
                    activeSpan?.addEvent("llm.prompt", {
                        "prompt.text": truncatedPrompt,
                        "prompt.full_length": this.lastUserMessage.length,
                        "prompt.truncated": this.lastUserMessage.length > 2000,
                    });
                }

                // Log the actual response text so it shows up in Jaeger's Logs section
                // This makes it much easier to see what the LLM actually generated
                if (e.text) {
                    // Truncate to avoid massive log entries (OTel has limits)
                    const truncatedText = e.text.length > 4000
                        ? e.text.substring(0, 4000) + "... [truncated]"
                        : e.text;
                    activeSpan?.addEvent("llm.response", {
                        "response.text": truncatedText,
                        "response.full_length": e.text.length,
                        "response.truncated": e.text.length > 4000,
                    });
                }

                // Clear cached content after use
                this.cachedContentForComplete = "";
                this.lastUserMessage = undefined;
            } catch (error) {
                const errorTime = Date.now();
                activeSpan?.addEvent("llm.onFinish_error", {
                    "error.message": error instanceof Error ? error.message : String(error),
                    "error.type": error instanceof Error ? error.constructor.name : typeof error,
                    "error.ms_since_onFinish_start": errorTime - onFinishStartTime,
                });
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
        this.emit("content", { delta: text });
        this.cachedContentForComplete += text;
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
            usage: this.currentStepUsage
                ? { ...this.currentStepUsage, contextWindow: this.getModelContextWindow() }
                : undefined,
        });
    }

    private handleToolResult(toolCallId: string, toolName: string, result: unknown): void {
        const hasError = isToolResultError(result);

        if (hasError) {
            const errorDetails = extractErrorDetails(result);
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
     * Create a language model instance for dynamic model switching.
     * Used by AgentExecutor when the change_model tool switches variants mid-run.
     *
     * @param provider - The provider ID (e.g., "openrouter", "anthropic")
     * @param model - The model ID (e.g., "anthropic/claude-3.5-sonnet")
     * @param registry - The AI SDK provider registry
     * @returns A LanguageModel instance for use in prepareStep
     */
    static createLanguageModelFromRegistry(
        provider: string,
        model: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        registry: ProviderRegistryProvider<any, any>
    ): LanguageModel {
        return registry.languageModel(`${provider}:${model}`);
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

            providerOptions: {
                openrouter: {
                    usage: { include: true },
                    user: this.getTraceCorrelationId(),
                    metadata: this.getOpenRouterMetadata(),
                },
            },
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
                    usage: result.usage,
                };
            },
            "Generate structured object",
            startTime
        );
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
