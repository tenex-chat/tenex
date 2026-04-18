import { ProgressMonitor } from "@/agents/execution/ProgressMonitor";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import {
    type LanguageModel,
    type LanguageModelUsage,
    type ProviderRegistryProvider,
    type StepResult,
    type Tool as CoreTool,
    type ToolChoice,
    type TextStreamPart,
    extractReasoningMiddleware,
    generateObject,
    generateText,
    streamText,
    wrapLanguageModel,
} from "ai";
import type { SharedV3ProviderOptions as ProviderOptions } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { EventEmitter } from "tseep";
import type { z } from "zod";
import { ChunkHandler, type ChunkHandlerState } from "./ChunkHandler";
import { createFinishHandler, type FinishHandlerConfig, type FinishHandlerState } from "./FinishHandler";
import { extractLastUserMessage, extractSystemContent } from "./MessageProcessor";
import { getDefaultProviderOptions, mergeProviderOptions } from "./provider-options";
import { getFullTelemetryConfig, getOpenRouterMetadata, getTraceCorrelationId } from "./TracingUtils";
import type { ProviderCapabilities } from "./providers/types";
import { extractLLMMetadata, extractUsageMetadata } from "./providers/usage-metadata";
import type {
    LLMAnalysisHooks,
    LLMAnalysisRequestHandle,
    LLMRequestAnalysisSeed,
    LanguageModelUsageWithCostUsd,
    LLMServiceEventMap,
} from "./types";
import { isRetryableKeyError } from "./retryable-key-errors";
import { getInvalidToolCallsFromStep } from "./utils/tool-errors";
import { getContextWindow, resolveContextWindow } from "./utils/context-window-cache";
import { extractLastStepUsage } from "./utils/usage";
import { setApiKeyIdentity } from "@/telemetry/LLMSpanRegistry";
import { prepareMultimodalMessagesForProvider } from "./multimodal-preparation";

/**
 * Accessor for live provider state. Called per-request so LLMService
 * always gets the current registry (after potential key rotation).
 */
export type StandardProviderAccessor = () => {
    registry: ProviderRegistryProvider;
    activeApiKey?: string;
    apiKeyIdentity?: string;
};

/**
 * Handler for rotating to a different API key after a failure.
 * Returns true if rotation succeeded and a retry is worthwhile.
 */
export type KeyRotationHandler = (providerId: string, failedKey: string) => Promise<boolean>;

type StreamPrepareStepResult = {
    model?: LanguageModel;
    messages?: ModelMessage[];
    providerOptions?: ProviderOptions;
    experimental_context?: unknown;
    toolChoice?: ToolChoice<Record<string, CoreTool>>;
    analysisRequestSeed?: LLMRequestAnalysisSeed;
};

/**
 * LLM Service for runtime execution with AI SDK providers
 * Pure runtime concerns - no configuration management
 */
export class LLMService extends EventEmitter<LLMServiceEventMap> {
    public readonly provider: string;
    public readonly model: string;
    private readonly capabilities: ProviderCapabilities;
    private readonly temperature?: number;
    private readonly maxTokens?: number;
    private previousChunkType?: string;
    private readonly agentProviderFunction?: (
        model: string,
        options?: Record<string, unknown>
    ) => LanguageModel;
    private readonly agentBaseSettings?: Record<string, unknown>;
    private readonly agentSlug?: string;
    private readonly agentId?: string;
    private readonly conversationId?: string;
    private readonly projectId?: string;
    private readonly analysisHooks?: LLMAnalysisHooks;
    private cachedContentForComplete = "";
    /** Usage from most recent completed LLM step, set via updateUsageFromSteps */
    private currentStepUsage?: LanguageModelUsageWithCostUsd;
    /** Last user message - stored before streaming for logging in onFinish */
    private lastUserMessage?: string;
    /** Chunk handler instance */
    private chunkHandler: ChunkHandler;
    /** Live accessor for current provider registry + active key (standard providers only) */
    private readonly standardProviderAccessor?: StandardProviderAccessor | null;
    /** Handler for rotating to a different API key on failure */
    private readonly keyRotationHandler?: KeyRotationHandler;

    constructor(
        standardProviderAccessor: StandardProviderAccessor | null,
        provider: string,
        model: string,
        capabilities: ProviderCapabilities,
        temperature?: number,
        maxTokens?: number,
        agentProviderFunction?: (model: string, options?: Record<string, unknown>) => LanguageModel,
        agentBaseSettings?: Record<string, unknown>,
        agentSlug?: string,
        conversationId?: string,
        projectId?: string,
        agentId?: string,
        analysisHooks?: LLMAnalysisHooks,
        keyRotationHandler?: KeyRotationHandler
    ) {
        super();
        this.standardProviderAccessor = standardProviderAccessor;
        this.provider = provider;
        this.model = model;
        this.capabilities = capabilities;
        this.temperature = temperature;
        this.maxTokens = maxTokens;
        this.agentProviderFunction = agentProviderFunction;
        this.agentBaseSettings = agentBaseSettings;
        this.agentSlug = agentSlug;
        this.conversationId = conversationId;
        this.projectId = projectId;
        this.agentId = agentId;
        this.analysisHooks = analysisHooks;
        this.keyRotationHandler = keyRotationHandler;

        if (!standardProviderAccessor && !agentProviderFunction) {
            throw new Error(
                "LLMService requires either a provider accessor or an agent provider function"
            );
        }

        // Initialize chunk handler with state accessors that sync to LLMService
        const getService = (): LLMService => this;
        const chunkHandlerState: ChunkHandlerState = {
            get previousChunkType() {
                return getService().previousChunkType;
            },
            set previousChunkType(value: string | undefined) {
                getService().previousChunkType = value;
            },
            get cachedContentForComplete() {
                return getService().cachedContentForComplete;
            },
            set cachedContentForComplete(value: string) {
                getService().cachedContentForComplete = value;
            },
            getCurrentStepUsage: () => getService().currentStepUsage,
            getModelContextWindow: () => getService().getModelContextWindow(),
        };
        this.chunkHandler = new ChunkHandler(this, chunkHandlerState);

        // Fire-and-forget: start resolving context window
        resolveContextWindow(this.provider, this.model).catch(() => {
            // Silently ignore - context window will be undefined if fetch fails
        });
    }

    /**
     * Update usage from most recent completed LLM step.
     * Called from prepareStep to make usage available for tool-will-execute events.
     * Extracts accurate usage from providerMetadata.openrouter.usage when available.
     */
    updateUsageFromSteps(steps: Array<{ usage?: { inputTokens?: number; outputTokens?: number } }>): void {
        this.currentStepUsage = extractLastStepUsage(steps);
    }

    /**
     * Get usage from most recent completed LLM step.
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

    private resolveTelemetryModelIdentity(languageModel?: LanguageModel): {
        provider: string;
        model: string;
    } {
        if (
            languageModel &&
            typeof languageModel !== "string" &&
            "provider" in languageModel &&
            typeof languageModel.provider === "string" &&
            "modelId" in languageModel &&
            typeof languageModel.modelId === "string"
        ) {
            return {
                provider: languageModel.provider,
                model: languageModel.modelId,
            };
        }

        return {
            provider: this.provider,
            model: this.model,
        };
    }

    private getCurrentApiKeyIdentity(): string | undefined {
        if (!this.standardProviderAccessor) {
            return undefined;
        }
        return this.standardProviderAccessor().apiKeyIdentity;
    }

    /**
     * Create a wrapped AI SDK language model instance using this service's provider configuration.
     * Useful for callers that need to pass a model instance into other AI SDK helpers.
     */
    createLanguageModel(messages?: ModelMessage[]): LanguageModel {
        return this.getLanguageModel(messages);
    }

    /**
     * Get full telemetry configuration for the current service instance.
     */
    private getTelemetryConfig(
        additionalMetadata?: Record<string, string | number | boolean>
    ): ReturnType<typeof getFullTelemetryConfig> {
        return getFullTelemetryConfig({
            agentSlug: this.agentSlug,
            agentId: this.agentId,
            conversationId: this.conversationId,
            projectId: this.projectId,
            provider: this.provider,
            model: this.model,
            temperature: this.temperature,
            maxTokens: this.maxTokens,
            contextWindow: this.getModelContextWindow(),
            additionalMetadata,
        });
    }

    private getRequestProviderOptions(
        extra?: ProviderOptions,
        additionalMetadata?: Record<string, string | number | boolean>
    ): ProviderOptions | undefined {
        const defaults = mergeProviderOptions(
            getDefaultProviderOptions(this.provider),
            this.provider === "openrouter"
                ? {
                      openrouter: {
                          usage: { include: true },
                          user: getTraceCorrelationId(),
                          metadata: getOpenRouterMetadata(
                              this.agentSlug,
                              this.conversationId,
                              this.projectId,
                              additionalMetadata
                          ),
                      },
                  }
                : undefined
        );

        return mergeProviderOptions(defaults, extra);
    }

    /**
     * Extract system content and record it on the active span for provider-agnostic telemetry.
     */
    private captureSystemPromptTelemetry(messages?: ModelMessage[]): string | null {
        const systemContent = messages ? extractSystemContent(messages) : null;

        if (systemContent) {
            const maxLength = 10000;
            const truncated = systemContent.length > maxLength;
            trace.getActiveSpan()?.addEvent("llm.system_prompt", {
                "system_prompt.text": truncated ? systemContent.slice(0, maxLength) : systemContent,
                "system_prompt.full_length": systemContent.length,
                "system_prompt.truncated": truncated,
                "system_prompt.provider": this.provider,
            });
        }

        return systemContent;
    }

    /**
     * Get a language model instance.
     * For agent providers: creates the model from the provider function.
     * For standard providers: gets the model from the registry.
     * Wraps all models with extract-reasoning-middleware.
     */
    private getLanguageModel(messages?: ModelMessage[]): LanguageModel {
        let baseModel: LanguageModel;

        this.captureSystemPromptTelemetry(messages);

        if (this.agentProviderFunction) {
            const options = { ...this.agentBaseSettings };
            baseModel = this.agentProviderFunction(this.model, options);
        } else if (this.standardProviderAccessor) {
            // Standard providers use live accessor to get current registry
            const { registry } = this.standardProviderAccessor();
            baseModel = registry.languageModel(`${this.provider}:${this.model}`);
        } else {
            throw new Error("No provider available for model creation");
        }

        return this.wrapWithMiddleware(baseModel);
    }

    /**
     * Build an attempt-scoped context for standard provider calls.
     * Captures both the registry and the active key from a single accessor call
     * so retry logic uses the correct key even under concurrent requests.
     */
    private createStandardAttemptContext(messages?: ModelMessage[]): {
        model: LanguageModel;
        failedKey?: string;
        apiKeyIdentity?: string;
    } {
        if (!this.standardProviderAccessor) {
            return {
                model: this.getLanguageModel(messages),
            };
        }

        const { registry, activeApiKey, apiKeyIdentity } = this.standardProviderAccessor();
        this.captureSystemPromptTelemetry(messages);

        return {
            model: this.wrapWithMiddleware(registry.languageModel(`${this.provider}:${this.model}`)),
            failedKey: activeApiKey,
            apiKeyIdentity,
        };
    }

    /**
     * Wrap a base model with the standard middleware chain.
     * Used by both getLanguageModel() and createLanguageModelFromRegistry()
     * so all call paths get reasoning extraction.
     */
    private wrapWithMiddleware(baseModel: LanguageModel): LanguageModel {
        return wrapLanguageModel({
            model: baseModel as Parameters<typeof wrapLanguageModel>[0]["model"],
            middleware: extractReasoningMiddleware({
                tagName: "thinking",
                separator: "\n",
                startWithReasoning: false,
            }),
        });
    }

    private async prepareMessagesForProvider(
        messages: ModelMessage[],
        abortSignal?: AbortSignal
    ): Promise<ModelMessage[]> {
        return prepareMultimodalMessagesForProvider(messages, {
            provider: this.provider,
            model: this.model,
            abortSignal,
        });
    }

    async stream(
        messages: ModelMessage[],
        tools: Record<string, AISdkTool>,
        options?: {
            abortSignal?: AbortSignal;
            providerOptions?: ProviderOptions;
            experimentalContext?: unknown;
            toolChoice?: ToolChoice<Record<string, CoreTool>>;
            analysisRequestSeed?: LLMRequestAnalysisSeed;
            prepareStep?: (step: {
                messages: ModelMessage[];
                stepNumber: number;
                steps: StepResult<Record<string, AISdkTool>>[];
            }) => PromiseLike<StreamPrepareStepResult | undefined> | StreamPrepareStepResult | undefined;
            /** Custom stopWhen callback that wraps the default progress monitor check */
            onStopCheck?: (steps: StepResult<Record<string, AISdkTool>>[]) => Promise<boolean>;
            onFinalStepInputTokens?: (
                actualInputTokens: number | null | undefined
            ) => Promise<void> | void;
        }
    ): Promise<void> {
        const startTime = Date.now();
        const attempt = this.createStandardAttemptContext(messages);
        const attemptKey = attempt.failedKey;
        const model = attempt.model;

        // Extract last user message for logging
        this.lastUserMessage = extractLastUserMessage(messages);

        // First attempt: suppress stream-error to allow retry
        const firstResult = await this.runStreamAttempt(
            model,
            messages,
            tools,
            options,
            startTime,
            { emitStreamError: false, apiKeyIdentity: attempt.apiKeyIdentity }
        );

        if (firstResult.success) return;

        // Check if retry is possible
        const retryableKeyError = isRetryableKeyError(firstResult.error);
        if (
            attemptKey === undefined ||
            this.keyRotationHandler === undefined ||
            !retryableKeyError
        ) {
            trace.getActiveSpan()?.addEvent("llm.stream_retry_not_attempted", {
                "retry.active_key_present": attemptKey !== undefined,
                "retry.key_rotation_handler_present": this.keyRotationHandler !== undefined,
                "retry.error_retryable": retryableKeyError,
                "retry.chunk_count_at_error": firstResult.chunkCount,
                "retry.last_chunk_type": firstResult.lastChunkType ?? "none",
            });

            // No retry possible — emit the suppressed stream-error and throw
            this.emit("stream-error", { error: firstResult.error });
            await this.handleStreamError(firstResult.error, startTime);
            throw firstResult.error;
        }

        // Attempt key rotation
        const rotated = await this.keyRotationHandler(this.provider, attemptKey);
        if (!rotated) {
            this.emit("stream-error", { error: firstResult.error });
            await this.handleStreamError(firstResult.error, startTime);
            throw firstResult.error;
        }

        logger.info("[LLMService] Retrying stream after key rotation", {
            provider: this.provider,
            model: this.model,
        });
        trace.getActiveSpan()?.addEvent("llm.stream_retry_after_key_rotation", {
            "llm.provider": this.provider,
            "llm.model": this.model,
        });

        // Retry with fresh model from rotated provider
        const retryAttempt = this.createStandardAttemptContext(messages);
        const retryModel = retryAttempt.model;
        const retryResult = await this.runStreamAttempt(
            retryModel,
            messages,
            tools,
            options,
            startTime,
            { emitStreamError: true, apiKeyIdentity: retryAttempt.apiKeyIdentity }
        );

        if (!retryResult.success) {
            await this.handleStreamError(retryResult.error, startTime);
            throw retryResult.error;
        }
    }

    /**
     * Run a single stream attempt. Returns success/failure with error and stream part stats.
     * When emitStreamError is false, the onError callback suppresses stream-error emission
     * so the caller can decide whether to retry or emit.
     */
    private async runStreamAttempt(
        model: LanguageModel,
        preparedMessages: ModelMessage[],
        tools: Record<string, AISdkTool>,
        options: {
            abortSignal?: AbortSignal;
            providerOptions?: ProviderOptions;
            experimentalContext?: unknown;
            toolChoice?: ToolChoice<Record<string, CoreTool>>;
            analysisRequestSeed?: LLMRequestAnalysisSeed;
            prepareStep?: (step: {
                messages: ModelMessage[];
                stepNumber: number;
                steps: StepResult<Record<string, AISdkTool>>[];
            }) => PromiseLike<StreamPrepareStepResult | undefined> | StreamPrepareStepResult | undefined;
            onStopCheck?: (steps: StepResult<Record<string, AISdkTool>>[]) => Promise<boolean>;
            onFinalStepInputTokens?: (
                actualInputTokens: number | null | undefined
            ) => Promise<void> | void;
        } | undefined,
        startTime: number,
        { emitStreamError, apiKeyIdentity }: { emitStreamError: boolean; apiKeyIdentity?: string }
    ): Promise<
        | { success: true }
        | { success: false; error: unknown; chunkCount: number; lastChunkType?: string }
    > {
        const providerPreparedMessages = await this.prepareMessagesForProvider(
            preparedMessages,
            options?.abortSignal
        );

        // ProgressMonitor is only used for providers without built-in tools
        let progressMonitor: ProgressMonitor | undefined;
        if (!this.capabilities.builtInTools) {
            const reviewModel = this.getLanguageModel();
            progressMonitor = new ProgressMonitor(reviewModel);
        }

        const stopWhen = async ({
            steps,
        }: { steps: StepResult<Record<string, AISdkTool>>[] }): Promise<boolean> => {
            if (options?.onStopCheck) {
                const shouldStop = await options.onStopCheck(steps);
                if (shouldStop) return true;
            }
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

        const activeSpan = trace.getActiveSpan();
        if (activeSpan && apiKeyIdentity) {
            activeSpan.setAttribute("llm.api_key_identity", apiKeyIdentity);
            // Store in trace registry so span processor can add it to ai.streamText.doStream spans
            const traceId = activeSpan.spanContext().traceId;
            setApiKeyIdentity(traceId, apiKeyIdentity);
        }
        activeSpan?.addEvent("llm.streamText_preparing", {
            "stream.messages_count": providerPreparedMessages.length,
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

        // DIAGNOSTIC: Track inter-chunk timing for concurrent streaming bottleneck analysis
        let maxInterChunkDelayMs = 0;
        let totalInterChunkDelayMs = 0;
        const interChunkDelays: number[] = [];
        const SLOW_CHUNK_THRESHOLD_MS = 500;

        // Capture errors from onError — the AI SDK swallows them and doesn't re-throw
        // in fullStream, so we need to capture them here to propagate correctly.
        let onErrorCapture: unknown = undefined;
        const stepAnalysisHandles = new Map<number, LLMAnalysisRequestHandle>();
        const finalizedAnalysisSteps = new Set<number>();
        const finalizeOpenStepErrors = async (error: unknown): Promise<void> => {
            const completedAt = Date.now();
            for (const [stepNumber, handle] of stepAnalysisHandles.entries()) {
                if (finalizedAnalysisSteps.has(stepNumber)) {
                    continue;
                }
                finalizedAnalysisSteps.add(stepNumber);
                await handle.reportError({ completedAt, error });
            }
        };
        const countUnfinalizedStepHandles = (): number => {
            let count = 0;
            for (const stepNumber of stepAnalysisHandles.keys()) {
                if (!finalizedAnalysisSteps.has(stepNumber)) {
                    count++;
                }
            }
            return count;
        };
        const openStepAnalysis = async (params: {
            stepNumber: number;
            startedAt: number;
            messages: ModelMessage[];
            providerOptions?: ProviderOptions;
            toolChoice?: ToolChoice<Record<string, CoreTool>>;
            requestSeed?: LLMRequestAnalysisSeed;
            model?: LanguageModel;
            apiKeyIdentity?: string;
        }): Promise<void> => {
            if (!this.analysisHooks || stepAnalysisHandles.has(params.stepNumber)) {
                return;
            }

            const modelIdentity = this.resolveTelemetryModelIdentity(params.model);
            const handle = await this.analysisHooks.openRequest({
                operationKind: "stream",
                startedAt: params.startedAt,
                provider: modelIdentity.provider,
                model: modelIdentity.model,
                apiKeyIdentity: params.apiKeyIdentity,
                messages: params.messages,
                providerOptions: params.providerOptions,
                toolChoice: params.toolChoice,
                requestSeed: params.requestSeed,
            });

            if (handle) {
                stepAnalysisHandles.set(params.stepNumber, handle);
            }
        };
        const wrappedPrepareStep = options?.prepareStep
            ? async (step: {
                messages: ModelMessage[];
                stepNumber: number;
                steps: StepResult<Record<string, AISdkTool>>[];
            }) => {
                const prepared = await options.prepareStep?.(step);
                const preparedProviderOptions = prepared?.analysisRequestSeed?.telemetryMetadata
                    ? this.getRequestProviderOptions(
                        prepared.providerOptions,
                        prepared.analysisRequestSeed.telemetryMetadata
                    )
                    : prepared?.providerOptions;
                await openStepAnalysis({
                    stepNumber: step.stepNumber,
                    startedAt: Date.now(),
                    messages: prepared?.messages ?? step.messages,
                    providerOptions: preparedProviderOptions ?? options?.providerOptions,
                    toolChoice: prepared?.toolChoice ?? options?.toolChoice,
                    requestSeed: prepared?.analysisRequestSeed,
                    model: prepared?.model ?? model,
                    apiKeyIdentity,
                });

                if (!prepared) {
                    return undefined;
                }

                const { analysisRequestSeed: _ignoredAnalysisSeed, ...sdkPrepared } = prepared;
                const sdkMessages = sdkPrepared.messages
                    ? await this.prepareMessagesForProvider(sdkPrepared.messages, options?.abortSignal)
                    : undefined;
                return {
                    ...sdkPrepared,
                    ...(sdkMessages ? { messages: sdkMessages } : {}),
                    providerOptions: preparedProviderOptions,
                };
            }
            : undefined;

        if (!wrappedPrepareStep) {
            await openStepAnalysis({
                stepNumber: 0,
                startedAt: Date.now(),
                messages: preparedMessages,
                providerOptions: options?.providerOptions,
                toolChoice: options?.toolChoice,
                requestSeed: options?.analysisRequestSeed,
                model,
                apiKeyIdentity,
            });
        }

        const { fullStream } = streamText({
            model,
            messages: providerPreparedMessages,
            ...(!this.capabilities.builtInTools && { tools }),
            ...(!this.capabilities.builtInTools &&
                options?.toolChoice !== undefined && { toolChoice: options.toolChoice }),
            temperature: this.temperature,
            maxOutputTokens: this.maxTokens,
            stopWhen,
            prepareStep: wrappedPrepareStep,
            abortSignal: options?.abortSignal,
            experimental_context: options?.experimentalContext,

            experimental_telemetry: this.getTelemetryConfig(
                options?.analysisRequestSeed?.telemetryMetadata
            ),

            providerOptions: this.getRequestProviderOptions(
                options?.providerOptions,
                options?.analysisRequestSeed?.telemetryMetadata
            ),

            onChunk: (event) => this.chunkHandler.handleChunk(event),
            onStepFinish: async (stepResult) => {
                const handle = stepAnalysisHandles.get(stepResult.stepNumber);
                if (!handle || finalizedAnalysisSteps.has(stepResult.stepNumber)) {
                    return;
                }

                finalizedAnalysisSteps.add(stepResult.stepNumber);
                const stepModelIdentity = this.resolveTelemetryModelIdentity(
                    stepResult.model as LanguageModel | undefined
                );
                const usage = extractUsageMetadata(
                    stepModelIdentity.provider,
                    stepModelIdentity.model,
                    stepResult.usage,
                    stepResult.providerMetadata as Record<string, unknown> | undefined
                );
                const metadata = extractLLMMetadata(
                    stepModelIdentity.provider,
                    stepResult.providerMetadata as Record<string, unknown> | undefined
                );
                const completedAt = Date.now();
                const invalidToolCalls = getInvalidToolCallsFromStep(
                    stepResult,
                    stepResult.stepNumber
                );
                if (invalidToolCalls.length > 0) {
                    await handle.reportInvalidToolCalls({
                        invalidToolCalls,
                        recordedAt: completedAt,
                    });
                }
                await handle.reportSuccess({
                    completedAt,
                    usage,
                    finishReason: stepResult.finishReason,
                    metadata,
                });
            },
            onFinish: createFinishHandler(this, finishConfig, finishState, {
                onFinalStepInputTokens: options?.onFinalStepInputTokens,
            }),
            onError: ({ error }) => {
                activeSpan?.addEvent("llm.onError_called", {
                    "error.message": error instanceof Error ? error.message : String(error),
                    "error.type": error instanceof Error ? error.constructor.name : typeof error,
                    "stream.chunk_count_at_error": chunkCount,
                    "stream.last_chunk_type": lastChunkType ?? "none",
                });
                onErrorCapture = error;
                if (emitStreamError) {
                    this.emit("stream-error", { error });
                }
            },
        });

        try {
            for await (const part of fullStream) {
                const chunkReceivedTime = Date.now();
                const interChunkDelay = chunkReceivedTime - lastChunkTime;

                chunkCount++;
                lastChunkType = part.type;

                if (chunkCount > 1) {
                    totalInterChunkDelayMs += interChunkDelay;
                    interChunkDelays.push(interChunkDelay);
                    if (interChunkDelay > maxInterChunkDelayMs) {
                        maxInterChunkDelayMs = interChunkDelay;
                    }
                    if (interChunkDelay > SLOW_CHUNK_THRESHOLD_MS) {
                        activeSpan?.addEvent("llm.slow_chunk_detected", {
                            "chunk.number": chunkCount,
                            "chunk.type": part.type,
                            "chunk.inter_delay_ms": interChunkDelay,
                            "chunk.threshold_ms": SLOW_CHUNK_THRESHOLD_MS,
                            "process.memory_heap_used_mb": Math.round(
                                process.memoryUsage().heapUsed / 1024 / 1024
                            ),
                        });
                    }
                }

                lastChunkTime = chunkReceivedTime;

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
                    case "finish": {
                        finishPartSeen = true;
                        const finishReason = (part as { finishReason?: string }).finishReason;
                        if (!finishReason) {
                            throw new Error("[LLMService] Missing finish reason in finish chunk.");
                        }
                        activeSpan?.addEvent("llm.finish_part_received", {
                            "finish.reason": finishReason,
                            "stream.chunk_count": chunkCount,
                            "stream.ms_since_start": lastChunkTime - startTime,
                        });
                        break;
                    }
                    case "finish-step": {
                        stepFinishCount++;
                        const stepFinishReason = (part as { finishReason?: string }).finishReason;
                        if (!stepFinishReason) {
                            throw new Error("[LLMService] Missing finish reason in finish-step chunk.");
                        }
                        activeSpan?.addEvent("llm.step_finish_received", {
                            "step.number": stepFinishCount,
                            "step.finish_reason": stepFinishReason,
                            "stream.chunk_count": chunkCount,
                        });
                        break;
                    }
                }

                if (part.type === "finish") {
                    this.emit("raw-chunk", { chunk: part as TextStreamPart<Record<string, AISdkTool>> });
                } else if (part.type === "tool-error") {
                    this.chunkHandler.handleChunk({ chunk: part as TextStreamPart<Record<string, AISdkTool>> });
                }
            }

            // DIAGNOSTIC: Track when for-await loop completes with detailed stats
            const loopCompleteTime = Date.now();
            const loopDuration = loopCompleteTime - startTime;
            const timeSinceLastChunk = loopCompleteTime - lastChunkTime;

            const sortedDelays = [...interChunkDelays].sort((a, b) => a - b);
            const p50Delay = sortedDelays.length > 0
                ? sortedDelays[Math.floor(sortedDelays.length * 0.5)]
                : 0;
            const p95Delay = sortedDelays.length > 0
                ? sortedDelays[Math.floor(sortedDelays.length * 0.95)]
                : 0;
            const p99Delay = sortedDelays.length > 0
                ? sortedDelays[Math.floor(sortedDelays.length * 0.99)]
                : 0;
            const avgInterChunkDelay = interChunkDelays.length > 0
                ? totalInterChunkDelayMs / interChunkDelays.length
                : 0;

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
                "stream.inter_chunk_max_delay_ms": maxInterChunkDelayMs,
                "stream.inter_chunk_avg_delay_ms": Math.round(avgInterChunkDelay * 100) / 100,
                "stream.inter_chunk_p50_delay_ms": p50Delay,
                "stream.inter_chunk_p95_delay_ms": p95Delay,
                "stream.inter_chunk_p99_delay_ms": p99Delay,
                "stream.slow_chunks_count": interChunkDelays.filter(d => d > SLOW_CHUNK_THRESHOLD_MS).length,
            });

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

            // The AI SDK swallows errors into onError without re-throwing in fullStream.
            // If onError was called and the stream did not finish normally, propagate as failure.
            // Guard with !finishPartSeen: if a finish part was already received, the stream
            // completed successfully before onError fired (e.g. cleanup-phase error) and we
            // should not trigger a retry or emit a stream-error for that completed result.
            if (onErrorCapture !== undefined && !finishPartSeen) {
                const errorEventAttributes = {
                    "error.message": onErrorCapture instanceof Error ? onErrorCapture.message : String(onErrorCapture),
                    "error.type": onErrorCapture instanceof Error ? onErrorCapture.constructor.name : typeof onErrorCapture,
                    "stream.chunk_count_at_error": chunkCount,
                    "stream.last_chunk_type": lastChunkType ?? "none",
                    "stream.finish_part_seen": finishPartSeen,
                    "stream.abort_signal_aborted": options?.abortSignal?.aborted ?? false,
                    "error.source": "onError_callback",
                };
                if (emitStreamError) {
                    activeSpan?.addEvent("llm.stream_loop_error", errorEventAttributes);
                } else {
                    activeSpan?.addEvent("llm.stream_loop_retry_candidate", errorEventAttributes);
                }
                await finalizeOpenStepErrors(onErrorCapture);
                return { success: false, error: onErrorCapture, chunkCount, lastChunkType };
            }

            const remainingStepHandles = countUnfinalizedStepHandles();
            if (!finishPartSeen || remainingStepHandles > 0) {
                const reasons: string[] = [];
                if (!finishPartSeen) {
                    reasons.push("missing finish part");
                }
                if (remainingStepHandles > 0) {
                    reasons.push(`missing step finish for ${remainingStepHandles} analysis step(s)`);
                }

                const incompleteError = new Error(
                    `[LLMService] Incomplete stream: ${reasons.join("; ")}.`
                );
                activeSpan?.addEvent("llm.stream_incomplete_error", {
                    "error.message": incompleteError.message,
                    "stream.chunk_count": chunkCount,
                    "stream.last_chunk_type": lastChunkType ?? "none",
                    "stream.finish_part_seen": finishPartSeen,
                    "stream.unfinalized_step_handles": remainingStepHandles,
                    "stream.abort_signal_aborted": options?.abortSignal?.aborted ?? false,
                });
                await finalizeOpenStepErrors(incompleteError);
                return { success: false, error: incompleteError, chunkCount, lastChunkType };
            }

            return { success: true };
        } catch (error) {
            await finalizeOpenStepErrors(error);
            const errorEventAttributes = {
                "error.message": error instanceof Error ? error.message : String(error),
                "error.type": error instanceof Error ? error.constructor.name : typeof error,
                "stream.chunk_count_at_error": chunkCount,
                "stream.last_chunk_type": lastChunkType ?? "none",
                "stream.finish_part_seen": finishPartSeen,
                "stream.abort_signal_aborted": options?.abortSignal?.aborted ?? false,
            };

            if (emitStreamError) {
                activeSpan?.addEvent("llm.stream_loop_error", errorEventAttributes);
                logger.writeToWarnLog({
                    timestamp: new Date().toISOString(),
                    level: "error",
                    component: "LLMService",
                    message: "LLM stream loop error",
                    context: {
                        provider: this.provider,
                        model: this.model,
                        chunkCount,
                        lastChunkType: lastChunkType ?? "none",
                        finishPartSeen,
                        abortSignalAborted: options?.abortSignal?.aborted ?? false,
                    },
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                });
            } else {
                activeSpan?.addEvent("llm.stream_loop_retry_candidate", errorEventAttributes);
            }
            return { success: false, error, chunkCount, lastChunkType };
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
     * Create a wrapped language model for dynamic model switching.
     * Wraps the registry model with the same middleware chain
     * (sanitizer, reasoning extraction) used by all other call paths.
     */
    createLanguageModelFromRegistry(
        provider: string,
        model: string,
        registry: ProviderRegistryProvider
    ): LanguageModel {
        const baseModel = registry.languageModel(`${provider}:${model}`);
        return this.wrapWithMiddleware(baseModel);
    }

    /**
     * Execute object generation
     */
    private async executeObjectGeneration<T>(
        languageModel: LanguageModel,
        messages: ModelMessage[],
        schema: z.ZodSchema<T>,
        tools: Record<string, AISdkTool> | undefined,
        providerOptions?: ProviderOptions,
        telemetryMetadata?: Record<string, string | number | boolean>
    ): Promise<{
        object: T;
        usage: LanguageModelUsage;
        providerMetadata?: Record<string, unknown>;
    }> {
        const providerPreparedMessages = await this.prepareMessagesForProvider(messages);
        return await generateObject({
            model: languageModel,
            messages: providerPreparedMessages,
            schema,
            temperature: this.temperature,
            maxOutputTokens: this.maxTokens,
            ...(tools && Object.keys(tools).length > 0 ? { tools } : {}),

            // ✨ Enable full AI SDK telemetry
            experimental_telemetry: this.getTelemetryConfig(telemetryMetadata),

            providerOptions: this.getRequestProviderOptions(
                providerOptions,
                telemetryMetadata
            ),
        });
    }

    /**
     * Generate a structured object using AI SDK's generateObject
     */
    async generateObject<T>(
        messages: ModelMessage[],
        schema: z.ZodSchema<T>,
        tools?: Record<string, AISdkTool>,
        options?: {
            providerOptions?: ProviderOptions;
            analysisRequestSeed?: LLMRequestAnalysisSeed;
        }
    ): Promise<{ object: T; usage: LanguageModelUsageWithCostUsd }> {
        const startTime = Date.now();
        const analysisHandle = await this.analysisHooks?.openRequest({
            operationKind: "generate-object",
            startedAt: startTime,
            provider: this.provider,
            model: this.model,
            apiKeyIdentity: this.getCurrentApiKeyIdentity(),
            messages,
            providerOptions: options?.providerOptions,
            requestSeed: options?.analysisRequestSeed,
        });

        return this.withErrorHandling(
            async () => {
                trace.getActiveSpan()?.addEvent("llm.generate_object_start", {
                    "llm.provider": this.provider,
                    "llm.model": this.model,
                    "messages.count": messages.length,
                });

                const result = await this.withKeyRotationRetry(
                    (languageModel) =>
                        this.executeObjectGeneration(
                            languageModel,
                            messages,
                            schema,
                            tools,
                            options?.providerOptions,
                            analysisHandle?.telemetryMetadata
                        )
                );

                const duration = Date.now() - startTime;

                trace.getActiveSpan()?.addEvent("llm.generate_object_complete", {
                    "llm.provider": this.provider,
                    "llm.model": this.model,
                    "llm.duration_ms": duration,
                });

                const usage = extractUsageMetadata(
                    this.provider,
                    this.model,
                    result.usage,
                    result.providerMetadata as Record<string, unknown> | undefined
                );
                const metadata = extractLLMMetadata(
                    this.provider,
                    result.providerMetadata as Record<string, unknown> | undefined
                );
                await analysisHandle?.reportSuccess({
                    completedAt: Date.now(),
                    usage,
                    metadata,
                });

                return {
                    object: result.object,
                    usage,
                };
            },
            "Generate structured object",
            startTime,
            analysisHandle
        );
    }

    /**
     * Generate plain text output using AI SDK's generateText.
     * Unlike generateObject, this returns unstructured text directly from the model.
     */
    async generateText(
        messages: ModelMessage[],
        options?: {
            providerOptions?: ProviderOptions;
            analysisRequestSeed?: LLMRequestAnalysisSeed;
        }
    ): Promise<{ text: string; usage: LanguageModelUsageWithCostUsd }> {
        const startTime = Date.now();
        const analysisHandle = await this.analysisHooks?.openRequest({
            operationKind: "generate-text",
            startedAt: startTime,
            provider: this.provider,
            model: this.model,
            apiKeyIdentity: this.getCurrentApiKeyIdentity(),
            messages,
            providerOptions: options?.providerOptions,
            requestSeed: options?.analysisRequestSeed,
        });

        return this.withErrorHandling(
            async () => {
                trace.getActiveSpan()?.addEvent("llm.generate_text_start", {
                    "llm.provider": this.provider,
                    "llm.model": this.model,
                    "messages.count": messages.length,
                });

                const providerPreparedMessages = await this.prepareMessagesForProvider(messages);
                const result = await this.withKeyRotationRetry(
                    (languageModel) => generateText({
                        model: languageModel,
                        messages: providerPreparedMessages,
                        temperature: this.temperature,
                        maxOutputTokens: this.maxTokens,

                        experimental_telemetry: this.getTelemetryConfig(
                            analysisHandle?.telemetryMetadata
                        ),

                        providerOptions: this.getRequestProviderOptions(
                            options?.providerOptions,
                            analysisHandle?.telemetryMetadata
                        ),
                    })
                );

                const duration = Date.now() - startTime;

                trace.getActiveSpan()?.addEvent("llm.generate_text_complete", {
                    "llm.provider": this.provider,
                    "llm.model": this.model,
                    "llm.duration_ms": duration,
                    "text.length": result.text.length,
                });

                const usage = extractUsageMetadata(
                    this.provider,
                    this.model,
                    result.usage,
                    result.providerMetadata as Record<string, unknown> | undefined
                );
                const metadata = extractLLMMetadata(
                    this.provider,
                    result.providerMetadata as Record<string, unknown> | undefined
                );
                await analysisHandle?.reportSuccess({
                    completedAt: Date.now(),
                    usage,
                    metadata,
                });

                return {
                    text: result.text,
                    usage,
                };
            },
            "Generate text",
            startTime,
            analysisHandle
        );
    }

    /**
     * Run an LLM operation with one-shot key rotation retry.
     * Builds attempt context, runs once, and on retryable key error
     * rotates the key and retries with a fresh model.
     */
    private async withKeyRotationRetry<T>(
        operation: (languageModel: LanguageModel) => Promise<T>
    ): Promise<T> {
        const { model, failedKey } = this.createStandardAttemptContext();
        try {
            return await operation(model);
        } catch (error) {
            if (
                failedKey &&
                this.keyRotationHandler &&
                isRetryableKeyError(error)
            ) {
                const rotated = await this.keyRotationHandler(this.provider, failedKey);
                if (rotated) {
                    logger.info("[LLMService] Retrying after key rotation", {
                        provider: this.provider,
                        model: this.model,
                    });
                    const { model: retryModel } = this.createStandardAttemptContext();
                    return await operation(retryModel);
                }
            }
            throw error;
        }
    }

    /**
     * Higher-order function for centralized error handling
     */
    private async withErrorHandling<T>(
        operation: () => Promise<T>,
        operationName: string,
        startTime: number,
        analysisHandle?: LLMAnalysisRequestHandle
    ): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            const duration = Date.now() - startTime;
            await analysisHandle?.reportError({
                completedAt: Date.now(),
                error,
            });
            logger.error(`[LLMService] ${operationName} failed`, {
                provider: this.provider,
                model: this.model,
                duration,
                error: error instanceof Error ? error.message : String(error),
            });
            logger.writeToWarnLog({
                timestamp: new Date().toISOString(),
                level: "error",
                component: "LLMService",
                message: `${operationName} failed`,
                context: {
                    provider: this.provider,
                    model: this.model,
                    duration,
                },
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
            throw error;
        }
    }
}
