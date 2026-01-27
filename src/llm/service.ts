import { ProgressMonitor } from "@/agents/execution/ProgressMonitor";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import {
    type LanguageModel,
    type LanguageModelMiddleware,
    type LanguageModelUsage,
    type ProviderRegistryProvider,
    type StepResult,
    type TextStreamPart,
    extractReasoningMiddleware,
    generateObject,
    generateText,
    streamText,
    wrapLanguageModel,
} from "ai";
import type { ModelMessage } from "ai";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { EventEmitter } from "tseep";
import type { z } from "zod";
import { ChunkHandler, type ChunkHandlerState } from "./ChunkHandler";
import { createFinishHandler, type FinishHandlerConfig, type FinishHandlerState } from "./FinishHandler";
import { extractLastUserMessage, extractSystemContent, prepareMessagesForRequest } from "./MessageProcessor";
import { createFlightRecorderMiddleware } from "./middleware/flight-recorder";
import { PROVIDER_IDS } from "./providers/provider-ids";
import { getFullTelemetryConfig, getOpenRouterMetadata, getTraceCorrelationId } from "./TracingUtils";
import type { ProviderCapabilities } from "./providers/types";
import type { LanguageModelUsageWithCostUsd } from "./types";
import { getContextWindow, resolveContextWindow } from "./utils/context-window-cache";
import { calculateCumulativeUsage } from "./utils/usage";

// Re-export event types for backwards compatibility
export type {
    ChunkTypeChangeEvent,
    CompleteEvent,
    ContentEvent,
    RawChunkEvent,
    ReasoningEvent,
    SessionCapturedEvent,
    StreamErrorEvent,
    ToolDidExecuteEvent,
    ToolWillExecuteEvent,
} from "./types";

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
    /** Chunk handler instance */
    private chunkHandler: ChunkHandler;

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

        // Initialize chunk handler with state accessors that sync to LLMService
        const self = this;
        const chunkHandlerState: ChunkHandlerState = {
            get previousChunkType() {
                return self.previousChunkType;
            },
            set previousChunkType(value: string | undefined) {
                self.previousChunkType = value;
            },
            get cachedContentForComplete() {
                return self.cachedContentForComplete;
            },
            set cachedContentForComplete(value: string) {
                self.cachedContentForComplete = value;
            },
            getCurrentStepUsage: () => self.currentStepUsage,
            getModelContextWindow: () => self.getModelContextWindow(),
        };
        this.chunkHandler = new ChunkHandler(this, chunkHandlerState);

        // Fire-and-forget: start resolving context window
        resolveContextWindow(this.provider, this.model).catch(() => {
            // Silently ignore - context window will be undefined if fetch fails
        });
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
     * Get full telemetry configuration for the current service instance.
     */
    private getTelemetryConfig() {
        return getFullTelemetryConfig({
            agentSlug: this.agentSlug,
            provider: this.provider,
            model: this.model,
            temperature: this.temperature,
            maxTokens: this.maxTokens,
            sessionId: this.sessionId,
        });
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
                const systemContent = extractSystemContent(messages);
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

        const processedMessages = prepareMessagesForRequest(messages, this.provider);

        // Extract last user message for logging
        this.lastUserMessage = extractLastUserMessage(messages);

        const startTime = Date.now();

        // ProgressMonitor is only used for providers without built-in tools
        let progressMonitor: ProgressMonitor | undefined;
        if (!this.capabilities.builtInTools) {
            const reviewModel = this.getLanguageModel();
            progressMonitor = new ProgressMonitor(reviewModel);
        }

        const stopWhen = async ({
            steps,
        }: { steps: StepResult<Record<string, AISdkTool>>[] }): Promise<boolean> => {
            // First check custom stop condition
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

        // Create finish handler config and state
        const finishConfig: FinishHandlerConfig = {
            provider: this.provider,
            model: this.model,
            getModelContextWindow: () => this.getModelContextWindow(),
        };
        const finishState: FinishHandlerState = {
            getCachedContent: () => this.cachedContentForComplete,
            clearCachedContent: () => {
                this.cachedContentForComplete = "";
            },
            getLastUserMessage: () => this.lastUserMessage,
            clearLastUserMessage: () => {
                this.lastUserMessage = undefined;
            },
        };

        // DIAGNOSTIC: Track state before streamText call
        const activeSpan = trace.getActiveSpan();
        activeSpan?.addEvent("llm.streamText_preparing", {
            "stream.messages_count": processedMessages.length,
            "stream.tools_count": this.capabilities.builtInTools ? 0 : Object.keys(tools).length,
            "stream.abort_signal_present": !!options?.abortSignal,
            "stream.abort_signal_aborted": options?.abortSignal?.aborted ?? false,
            "stream.provider": this.provider,
            "stream.model": this.model,
        });

        // Track chunk statistics for post-mortem analysis
        let chunkCount = 0;
        let lastChunkType: string | undefined;
        let lastChunkTime = startTime;
        let toolInputStartCount = 0;
        let toolCallCount = 0;
        let toolResultCount = 0;
        let textDeltaCount = 0;
        let finishPartSeen = false;
        let stepFinishCount = 0;

        const { fullStream } = streamText({
            model,
            messages: processedMessages,
            // Don't pass tools for providers with built-in tools
            ...(!this.capabilities.builtInTools && { tools }),
            temperature: this.temperature,
            maxOutputTokens: this.maxTokens,
            stopWhen,
            prepareStep: options?.prepareStep,
            abortSignal: options?.abortSignal,

            // ✨ Enable full AI SDK telemetry
            experimental_telemetry: this.getTelemetryConfig(),

            providerOptions: {
                openrouter: {
                    usage: { include: true },
                    user: getTraceCorrelationId(),
                    metadata: getOpenRouterMetadata(this.agentSlug, this.conversationId),
                },
            },

            onChunk: (event) => this.chunkHandler.handleChunk(event),
            onFinish: createFinishHandler(this, finishConfig, finishState),
            onError: ({ error }) => {
                // Emit stream-error event for the executor to handle and publish to user
                activeSpan?.addEvent("llm.onError_called", {
                    "error.message": error instanceof Error ? error.message : String(error),
                    "error.type": error instanceof Error ? error.constructor.name : typeof error,
                    "stream.chunk_count_at_error": chunkCount,
                    "stream.last_chunk_type": lastChunkType ?? "none",
                });
                this.emit("stream-error", { error });
            },
        });

        // Consume the stream (this is what triggers everything!)
        try {
            for await (const part of fullStream) {
                chunkCount++;
                lastChunkType = part.type;
                lastChunkTime = Date.now();

                // Track specific part types for diagnostics
                switch (part.type) {
                    case "tool-input-start":
                        toolInputStartCount++;
                        break;
                    case "tool-call":
                        toolCallCount++;
                        break;
                    case "tool-result":
                        toolResultCount++;
                        break;
                    case "text-delta":
                        textDeltaCount++;
                        break;
                    case "finish":
                        finishPartSeen = true;
                        activeSpan?.addEvent("llm.finish_part_received", {
                            "finish.reason": (part as { finishReason?: string }).finishReason ?? "unknown",
                            "stream.chunk_count": chunkCount,
                            "stream.ms_since_start": lastChunkTime - startTime,
                        });
                        break;
                    case "finish-step":
                        stepFinishCount++;
                        activeSpan?.addEvent("llm.step_finish_received", {
                            "step.number": stepFinishCount,
                            "step.finish_reason": (part as { finishReason?: string }).finishReason ?? "unknown",
                            "stream.chunk_count": chunkCount,
                        });
                        break;
                }

                // Handle tool-error events that don't come through onChunk
                if (part.type === "tool-error") {
                    this.chunkHandler.handleChunk({ chunk: part as TextStreamPart<Record<string, AISdkTool>> });
                }
            }

            // DIAGNOSTIC: Track when for-await loop completes with detailed stats
            const loopCompleteTime = Date.now();
            const loopDuration = loopCompleteTime - startTime;
            const timeSinceLastChunk = loopCompleteTime - lastChunkTime;
            activeSpan?.addEvent("llm.stream_loop_complete", {
                "stream.loop_complete_time": loopCompleteTime,
                "stream.loop_duration_ms": loopDuration,
                "stream.cached_content_length": this.cachedContentForComplete.length,
                "stream.total_chunk_count": chunkCount,
                "stream.last_chunk_type": lastChunkType ?? "none",
                "stream.ms_since_last_chunk": timeSinceLastChunk,
                "stream.finish_part_seen": finishPartSeen,
                "stream.step_finish_count": stepFinishCount,
                "stream.tool_input_start_count": toolInputStartCount,
                "stream.tool_call_count": toolCallCount,
                "stream.tool_result_count": toolResultCount,
                "stream.text_delta_count": textDeltaCount,
                "stream.abort_signal_aborted": options?.abortSignal?.aborted ?? false,
            });

            // CRITICAL DIAGNOSTIC: If loop completed but no finish part was seen, something is very wrong
            if (!finishPartSeen && chunkCount > 0) {
                activeSpan?.addEvent("llm.stream_incomplete_warning", {
                    "warning.message": "Stream loop completed without seeing finish part",
                    "stream.chunk_count": chunkCount,
                    "stream.last_chunk_type": lastChunkType ?? "none",
                    "stream.tool_input_start_count": toolInputStartCount,
                    "stream.tool_call_count": toolCallCount,
                    "stream.tool_result_count": toolResultCount,
                });
                logger.warn("[LLMService] Stream loop completed without finish part", {
                    chunkCount,
                    lastChunkType,
                    toolInputStartCount,
                    toolCallCount,
                    toolResultCount,
                    provider: this.provider,
                    model: this.model,
                });
            }
        } catch (error) {
            // DIAGNOSTIC: Track error with stream state
            activeSpan?.addEvent("llm.stream_loop_error", {
                "error.message": error instanceof Error ? error.message : String(error),
                "error.type": error instanceof Error ? error.constructor.name : typeof error,
                "stream.chunk_count_at_error": chunkCount,
                "stream.last_chunk_type": lastChunkType ?? "none",
                "stream.finish_part_seen": finishPartSeen,
                "stream.abort_signal_aborted": options?.abortSignal?.aborted ?? false,
            });
            await this.handleStreamError(error, startTime);
            throw error;
        }
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

    /**
     * Get the language model for use with AI SDK's generateObject and other functions
     */
    getModel(): LanguageModel {
        return this.getLanguageModel();
    }

    /**
     * Create a language model instance for dynamic model switching.
     * Used by AgentExecutor when the change_model tool switches variants mid-run.
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
            maxOutputTokens: this.maxTokens,
            ...(tools && Object.keys(tools).length > 0 ? { tools } : {}),

            // ✨ Enable full AI SDK telemetry
            experimental_telemetry: this.getTelemetryConfig(),

            providerOptions: {
                openrouter: {
                    usage: { include: true },
                    user: getTraceCorrelationId(),
                    metadata: getOpenRouterMetadata(this.agentSlug, this.conversationId),
                },
            },
        });
    }

    /**
     * Generate a structured object using AI SDK's generateObject
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
     * Generate plain text output using AI SDK's generateText.
     * Unlike generateObject, this returns unstructured text directly from the model.
     */
    async generateText(
        messages: ModelMessage[]
    ): Promise<{ text: string; usage: LanguageModelUsageWithCostUsd }> {
        const startTime = Date.now();

        return this.withErrorHandling(
            async () => {
                trace.getActiveSpan()?.addEvent("llm.generate_text_start", {
                    "llm.provider": this.provider,
                    "llm.model": this.model,
                    "messages.count": messages.length,
                });

                const languageModel = this.getLanguageModel();
                const result = await generateText({
                    model: languageModel,
                    messages,
                    temperature: this.temperature,
                    maxOutputTokens: this.maxTokens,

                    // ✨ Enable full AI SDK telemetry
                    experimental_telemetry: this.getTelemetryConfig(),

                    providerOptions: {
                        openrouter: {
                            usage: { include: true },
                            user: getTraceCorrelationId(),
                            metadata: getOpenRouterMetadata(this.agentSlug, this.conversationId),
                        },
                    },
                });

                const duration = Date.now() - startTime;

                trace.getActiveSpan()?.addEvent("llm.generate_text_complete", {
                    "llm.provider": this.provider,
                    "llm.model": this.model,
                    "llm.duration_ms": duration,
                    "text.length": result.text.length,
                });

                return {
                    text: result.text,
                    usage: result.usage,
                };
            },
            "Generate text",
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
