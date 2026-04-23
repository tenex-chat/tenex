/**
 * StreamExecutionHandler - Handles LLM streaming execution with event processing
 *
 * This class encapsulates stream event handling and coordinates
 * LLM streaming with message persistence and delegation handling.
 * Callbacks are created via StreamCallbacks module.
 */

import { formatAnyError, formatStreamError } from "@/lib/error-formatter";
import type {
    ChunkTypeChangeEvent,
    CompleteEvent,
    ContentEvent,
    ReasoningEvent,
    StreamErrorEvent,
} from "@/llm/types";
import { shortenConversationId } from "@/utils/conversation-id";
import type { EventContext } from "@/nostr/types";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { RALRegistry } from "@/services/ral";
import type { SkillToolPermissions } from "@/services/skill";
import { clearLLMSpanId } from "@/telemetry/LLMSpanRegistry";
import type { AISdkTool } from "@/tools/types";
import { createEventContext } from "@/services/event-context";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type { LanguageModel } from "ai";
import chalk from "chalk";
import type { LLMService } from "@/llm/service";
import type { ExecutionContextManagement } from "./context-management";
import type { MessageCompiler } from "./MessageCompiler";
import type { ToolExecutionTracker } from "./ToolExecutionTracker";
import { createPrepareStep } from "./StreamCallbacks";
import { setupToolEventHandlers } from "./ToolEventHandlers";
import type { ToolEventHandlerSideEffects } from "./ToolEventHandlers";
import type {
    FullRuntimeContext,
    LLMModelRequest,
    RALExecutionContext,
    StreamExecutionResult,
} from "./types";
import { extractLastUserMessage } from "./utils";

const NO_RESPONSE_ABORT_REASON = "NO_RESPONSE_ABORT";

/**
 * Configuration for stream execution
 */
export interface StreamExecutionConfig {
    context: FullRuntimeContext;
    toolTracker: ToolExecutionTracker;
    ralNumber: number;
    toolsObject: Record<string, AISdkTool>;
    llmService: LLMService;
    messageCompiler: MessageCompiler;
    request: LLMModelRequest;
    contextManagement?: ExecutionContextManagement;
    /** Tool permissions extracted from skill events (needed for tool permission enforcement) */
    skillToolPermissions: SkillToolPermissions;
    abortSignal: AbortSignal;
    metaModelSystemPrompt?: string;
    variantSystemPrompt?: string;
    /**
     * Resumption claim token acquired by the execution caller. Passed only on
     * the first stream invocation for a given dispatch; on supervision
     * re-engagement this is undefined because the original claim has already
     * been handed off. When present, `execute()` calls
     * `handOffResumptionClaimToStream` atomically with `setStreaming(true)` so
     * the claim transfers ownership from the caller scope to the live
     * streaming flag.
     */
    resumptionClaimToken?: string;
}

/**
 * Handles all LLM stream event processing and coordination
 */
export class StreamExecutionHandler {
    private static readonly STREAM_TEXT_DELTA_THROTTLE_MS = 1000;

    private contentBuffer = "";
    private reasoningBuffer = "";
    private streamTextDeltaBuffer = "";
    private streamTextDeltaSequence = 0;
    private streamTextDeltaTimer: NodeJS.Timeout | undefined;
    private streamTextDeltaFlushChain: Promise<void> = Promise.resolve();
    private streamTextDeltaEventContext: EventContext | undefined;
    private result: StreamExecutionResult | undefined;
    private lastUsedVariant: string | undefined;
    private currentModel: LanguageModel | undefined;
    private silentTerminationRequested = false;
    private readonly internalAbortController = new AbortController();
    private readonly effectiveAbortSignal: AbortSignal;
    private readonly execContext: RALExecutionContext;
    private readonly executionSpan = trace.getActiveSpan();
    private toolSideEffects: ToolEventHandlerSideEffects | undefined;

    constructor(private readonly config: StreamExecutionConfig) {
        this.lastUsedVariant = config.context.conversationStore.getMetaModelVariantOverride(
            config.context.agent.pubkey
        );
        this.effectiveAbortSignal = this.combineAbortSignals(
            config.abortSignal,
            this.internalAbortController.signal
        );
        this.execContext = {
            accumulatedMessages: [],
            pendingContextManagementUsageReporter: config.request.reportContextManagementUsage,
        };
    }

    /**
     * Execute the stream and return the result
     */
    async execute(): Promise<StreamExecutionResult> {
        const { context, llmService, toolsObject, abortSignal } = this.config;
        const ralRegistry = RALRegistry.getInstance();
        const conversationStore = context.conversationStore;
        const ralNumber = this.config.ralNumber;
        const request = this.config.request;
        const messages = request.messages;

        // Initialize execution context
        this.execContext.accumulatedMessages = messages;

        // Setup all event handlers
        this.setupEventHandlers();

        try {
            // Mark this RAL as streaming and start timing LLM runtime.
            // If the dispatcher pre-claimed this RAL via tryAcquireResumptionClaim,
            // hand the claim off to the streaming flag: `isStreaming = true` is
            // now the authoritative busy marker, and the dispatch-scope finally
            // block (which calls `releaseResumptionClaim(token)`) will observe
            // the cleared token and no-op. This ordering — set streaming then
            // clear token — is safe because both happen synchronously in the
            // same tick and concurrent dispatches would see isStreaming first.
            ralRegistry.setStreaming(context.agent.pubkey, context.conversationId, ralNumber, true);
            if (this.config.resumptionClaimToken !== undefined) {
                ralRegistry.handOffResumptionClaimToStream(
                    context.agent.pubkey,
                    context.conversationId,
                    ralNumber,
                    this.config.resumptionClaimToken
                );
            }
            const lastUserMessage = extractLastUserMessage(messages);
            ralRegistry.startLLMStream(context.agent.pubkey, context.conversationId, ralNumber, lastUserMessage);

            // DIAGNOSTIC: Capture process state at stream start for bottleneck analysis
            const memUsage = process.memoryUsage();
            const cpuUsage = process.cpuUsage();
            this.executionSpan?.addEvent("executor.stream_start_process_state", {
                "process.memory_heap_used_mb": Math.round(memUsage.heapUsed / 1024 / 1024),
                "process.memory_heap_total_mb": Math.round(memUsage.heapTotal / 1024 / 1024),
                "process.memory_rss_mb": Math.round(memUsage.rss / 1024 / 1024),
                "process.memory_external_mb": Math.round(memUsage.external / 1024 / 1024),
                "process.cpu_user_ms": Math.round(cpuUsage.user / 1000),
                "process.cpu_system_ms": Math.round(cpuUsage.system / 1000),
                "ral.number": ralNumber,
                "agent.slug": context.agent.slug,
            });

            // Add TENEX-specific attributes to the active span
            const activeSpan = trace.getActiveSpan();
            if (activeSpan) {
                activeSpan.setAttributes({
                    "tenex.agent.slug": context.agent.slug,
                    "tenex.agent.name": context.agent.name,
                    "tenex.agent.pubkey": context.agent.pubkey,
                    "tenex.conversation.id": shortenConversationId(context.conversationId),
                    "tenex.ral.number": ralNumber,
                    "tenex.delegation.chain":
                        conversationStore.metadata.delegationChain
                            ?.map((e) => e.displayName)
                            .join(" -> ") ?? "",
                });
            }

            // Create callbacks using extracted factory functions
            const prepareStep = createPrepareStep({
                context,
                llmService: {
                    provider: llmService.provider,
                    model: llmService.model,
                    updateUsageFromSteps: (steps) => llmService.updateUsageFromSteps(steps),
                    createLanguageModelFromRegistry: (provider, model, registry) =>
                        llmService.createLanguageModelFromRegistry(provider, model, registry),
                },
                messageCompiler: this.config.messageCompiler,
                toolsObject,
                contextManagement: this.config.contextManagement,
                initialRequest: request,
                skillToolPermissions: this.config.skillToolPermissions,
                ralNumber,
                execContext: this.execContext,
                executionSpan: this.executionSpan,
                modelState: {
                    lastUsedVariant: this.lastUsedVariant,
                    currentModel: this.currentModel,
                    setVariant: (v) => { this.lastUsedVariant = v; },
                    setModel: (m) => { this.currentModel = m; },
                },
            });

            // DIAGNOSTIC: Track when we're about to call stream()
            const streamCallStartTime = Date.now();
            this.executionSpan?.addEvent("executor.stream_call_starting", {
                "stream.call_start_time": streamCallStartTime,
                "stream.messages_count": messages.length,
                "stream.tools_count": Object.keys(toolsObject).length,
                "stream.abort_signal_aborted": abortSignal.aborted,
                "ral.number": ralNumber,
            });

            await llmService.stream(messages, toolsObject, {
                abortSignal: this.effectiveAbortSignal,
                prepareStep,
                onStopCheck: async () => this.silentTerminationRequested,
                providerOptions: request.providerOptions,
                experimentalContext: request.experimentalContext,
                toolChoice: request.toolChoice,
                analysisRequestSeed: request.analysisRequestSeed,
                onFinalStepInputTokens: async (actualInputTokens) => {
                    const reporter = this.execContext.pendingContextManagementUsageReporter;
                    this.execContext.pendingContextManagementUsageReporter = undefined;
                    await reporter?.(actualInputTokens);
                },
            });

            if (this.silentTerminationRequested && !this.result) {
                this.ensureSilentCompletionResult("stream-return-without-terminal-event");
            }

            await this.flushStreamTextDeltas({
                force: true,
                reason: "stream-return",
            });

            // DIAGNOSTIC: Track when stream() returns with process state comparison
            const streamCallEndTime = Date.now();
            const streamCallDuration = streamCallEndTime - streamCallStartTime;
            const endMemUsage = process.memoryUsage();
            const endCpuUsage = process.cpuUsage(cpuUsage); // Delta since start
            this.executionSpan?.addEvent("executor.stream_call_completed", {
                "stream.call_end_time": streamCallEndTime,
                "stream.call_duration_ms": streamCallDuration,
                "stream.result_set_after_stream": this.result !== undefined,
                "stream.result_kind_after_stream": this.result?.kind ?? "undefined",
                "stream.abort_signal_aborted_after": abortSignal.aborted,
                "ral.number": ralNumber,
                // Process state delta for bottleneck analysis
                "process.memory_heap_delta_mb": Math.round((endMemUsage.heapUsed - memUsage.heapUsed) / 1024 / 1024),
                "process.memory_rss_delta_mb": Math.round((endMemUsage.rss - memUsage.rss) / 1024 / 1024),
                "process.cpu_user_delta_ms": Math.round(endCpuUsage.user / 1000),
                "process.cpu_system_delta_ms": Math.round(endCpuUsage.system / 1000),
            });

            // Diagnostic: Track when stream method returns
            const streamReturnTime = Date.now();
            this.executionSpan?.addEvent("executor.stream_returned", {
                "stream.return_time": streamReturnTime,
                "stream.result_set": this.result !== undefined,
                "stream.result_kind": this.result?.kind ?? "undefined",
                "ral.number": ralNumber,
            });
        } catch (streamError) {
            await this.handleStreamError(streamError, this.effectiveAbortSignal);
        } finally {
            await this.toolSideEffects?.waitForIdle();
            await this.cleanup();
        }

        // Flush any remaining reasoning buffer
        if (this.reasoningBuffer.trim().length > 0) {
            await this.flushReasoningBuffer();
        }

        const { llmService: svc } = this.config;

        // Capture accumulated runtime for caller
        const accumulatedRuntime = ralRegistry.getAccumulatedRuntime(
            context.agent.pubkey,
            context.conversationId,
            ralNumber
        );

        // Diagnostic: Log state right before the critical result check
        const resultCheckTime = Date.now();
        this.executionSpan?.addEvent("executor.result_check", {
            "result.check_time": resultCheckTime,
            "result.is_defined": this.result !== undefined,
            "result.kind": this.result?.kind ?? "undefined",
            "ral.number": ralNumber,
            "stream.accumulated_runtime_ms": accumulatedRuntime,
            "agent.slug": context.agent.slug,
        });

        if (!this.result) {
            this.executionSpan?.addEvent("executor.result_undefined_error", {
                "error.type": "missing_result",
                "ral.number": ralNumber,
                "stream.accumulated_runtime_ms": accumulatedRuntime,
                "agent.slug": context.agent.slug,
                "agent.pubkey": context.agent.pubkey.substring(0, 8),
                "conversation.id": shortenConversationId(context.conversationId),
                "llm.provider": svc.provider,
                "llm.model": svc.model,
            });
            throw new Error("LLM stream completed without emitting complete or stream-error event");
        }

        // Set aborted flag and reason if stop signal was triggered
        if (this.result.kind === "complete" && abortSignal.aborted) {
            this.result.aborted = true;
            this.result.abortReason =
                typeof abortSignal.reason === "string" ? abortSignal.reason : undefined;
        }

        // Add accumulated runtime to result
        if (this.result.kind === "complete") {
            this.result.accumulatedRuntime = accumulatedRuntime;
        }

        return this.result;
    }

    /**
     * Setup all event handlers for the LLM service
     */
    private setupEventHandlers(): void {
        const { context, llmService, toolTracker, toolsObject } = this.config;
        const agentPublisher = context.agentPublisher;
        const eventContext = this.createEventContext();
        this.streamTextDeltaEventContext = eventContext;
        const ralNumber = this.config.ralNumber;

        llmService.on("content", (event: ContentEvent) => {
            if (this.silentTerminationRequested) {
                return;
            }
            process.stdout.write(chalk.white(event.delta));
            this.contentBuffer += event.delta;
            this.enqueueStreamTextDelta(event.delta);
        });

        llmService.on("reasoning", (event: ReasoningEvent) => {
            if (this.silentTerminationRequested) {
                return;
            }
            process.stdout.write(chalk.gray(event.delta));
            this.reasoningBuffer += event.delta;
        });

        llmService.on("chunk-type-change", async (event: ChunkTypeChangeEvent) => {
            if (this.silentTerminationRequested) {
                return;
            }
            if (event.from === "reasoning-delta") {
                await this.flushReasoningBuffer();
            }
            if (event.from === "text-delta") {
                await this.flushStreamTextDeltas({
                    force: true,
                    reason: "chunk-type-change",
                });
                await this.flushContentBuffer();
            }
        });

        // Track when we register the complete listener
        const completeListenerRegisteredAt = Date.now();
        this.executionSpan?.addEvent("executor.complete_listener_registered", {
            "listener.registered_at": completeListenerRegisteredAt,
            "ral.number": ralNumber,
        });

        llmService.on("complete", async (event: CompleteEvent) => {
            await this.flushStreamTextDeltas({
                force: true,
                reason: "complete",
            });

            if (!event.finishReason) {
                throw new Error("[StreamExecutionHandler] Missing finish reason for complete event.");
            }

            const completeReceivedTime = Date.now();
            const timeSinceRegistration = completeReceivedTime - completeListenerRegisteredAt;
            this.executionSpan?.addEvent("executor.complete_received", {
                "complete.received_at": completeReceivedTime,
                "complete.ms_since_listener_registered": timeSinceRegistration,
                "complete.message_length": event.message?.length ?? 0,
                "complete.steps_count": event.steps?.length ?? 0,
                "complete.finish_reason": event.finishReason,
                "complete.result_already_set": this.result !== undefined,
                "complete.result_kind": this.result?.kind ?? "none",
                "ral.number": ralNumber,
            });

            if (!this.result) {
                const completionEvent = this.silentTerminationRequested
                    ? { ...event, message: "" }
                    : event;
                this.result = {
                    kind: "complete",
                    event: completionEvent,
                    messageCompiler: this.config.messageCompiler,
                    accumulatedRuntime: 0,
                };
                this.executionSpan?.addEvent("executor.result_set_to_complete", {
                    "ral.number": ralNumber,
                });
            } else {
                this.executionSpan?.addEvent("executor.complete_ignored_result_exists", {
                    "existing_result.kind": this.result.kind,
                    "ral.number": ralNumber,
                });
            }
        });

        llmService.on("stream-error", async (event: StreamErrorEvent) => {
            await this.flushStreamTextDeltas({
                force: true,
                reason: "stream-error",
            });

            const errorReceivedTime = Date.now();
            const timeSinceRegistration = errorReceivedTime - completeListenerRegisteredAt;
            this.executionSpan?.addEvent("executor.stream_error_received", {
                "error.received_at": errorReceivedTime,
                "error.ms_since_listener_registered": timeSinceRegistration,
                "error.message": event.error instanceof Error ? event.error.message : String(event.error),
                "error.type": event.error instanceof Error ? event.error.constructor.name : typeof event.error,
                "error.result_already_set": this.result !== undefined,
                "error.result_kind": this.result?.kind ?? "none",
                "ral.number": ralNumber,
            });

            if (
                this.effectiveAbortSignal.aborted &&
                this.effectiveAbortSignal.reason === NO_RESPONSE_ABORT_REASON
            ) {
                this.executionSpan?.addEvent("executor.stream_error_ignored_for_no_response", {
                    "ral.number": ralNumber,
                    "agent.slug": context.agent.slug,
                });
                return;
            }

            logger.error("[StreamExecutionHandler] Stream error from LLMService", event);
            this.result = { kind: "error-handled" };

            try {
                const { message: errorMessage, errorType } = formatStreamError(event.error);
                await agentPublisher.error({ message: errorMessage, errorType }, eventContext);
            } catch (publishError) {
                logger.error("Failed to publish stream error event", {
                    error: formatAnyError(publishError),
                });
            }
        });

        // Setup tool event handlers via extracted module
        this.toolSideEffects = setupToolEventHandlers({
            context,
            llmService,
            toolTracker,
            toolsObject,
            eventContext,
            ralNumber,
            onNoResponseRequested: () => {
                this.requestSilentTermination();
            },
        });
    }

    /**
     * Create event context for publishing
     */
    private createEventContext(): EventContext {
        const { context, llmService } = this.config;
        const eventContext = createEventContext(context, { model: llmService.model });

        // DIAGNOSTIC: Track event context creation to debug llm-ral=0 issues
        this.executionSpan?.addEvent("executor.event_context_created", {
            "context.ral_number": eventContext.ralNumber,
            "context.conversation_id": eventContext.conversationId ? shortenConversationId(eventContext.conversationId) : "none",
            "context.model": eventContext.model ?? "none",
            "config.ral_number": this.config.ralNumber,
        });

        return eventContext;
    }

    /**
     * Flush reasoning buffer to publish interim reasoning
     */
    private async flushReasoningBuffer(): Promise<void> {
        if (this.reasoningBuffer.trim().length > 0) {
            const { context } = this.config;
            const eventContext = this.createEventContext();
            const contentToFlush = this.reasoningBuffer;

            // Add to conversation store BEFORE publishing - capture index for eventId reconciliation
            const messageIndex = context.conversationStore.addMessage({
                pubkey: context.agent.pubkey,
                ral: this.config.ralNumber,
                content: contentToFlush,
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });

            // Clear buffer BEFORE async publish to prevent re-adding on retry
            this.reasoningBuffer = "";

            try {
                const event = await context.agentPublisher.conversation(
                    { content: contentToFlush, isReasoning: true },
                    eventContext
                );

                // Link the published eventId to the message for loopback deduplication
                if (event.id && messageIndex >= 0) {
                    context.conversationStore.setEventId(messageIndex, event.id);
                }
            } catch (publishError) {
                // Log but don't throw - message is already in store, just unlinked
                // The loopback dedup will handle this gracefully (worst case: duplicate display)
                logger.warn("[StreamExecutionHandler] Failed to publish reasoning buffer", {
                    error: publishError instanceof Error ? publishError.message : String(publishError),
                    ralNumber: this.config.ralNumber,
                    agent: context.agent.slug,
                });
            }
        }
    }

    /**
     * Flush content buffer to publish interim text
     */
    private async flushContentBuffer(): Promise<void> {
        if (this.contentBuffer.trim().length > 0) {
            const { context } = this.config;
            const eventContext = this.createEventContext();
            const contentToFlush = this.contentBuffer;

            // Add to conversation store BEFORE publishing - capture index for eventId reconciliation
            const messageIndex = context.conversationStore.addMessage({
                pubkey: context.agent.pubkey,
                ral: this.config.ralNumber,
                content: contentToFlush,
                messageType: "text",
                timestamp: Math.floor(Date.now() / 1000),
            });

            // DIAGNOSTIC: Track content buffer flushes to correlate with duplicate message bug
            this.executionSpan?.addEvent("content_buffer.stored", {
                "content.preview": contentToFlush.slice(0, 120),
                "content.length": contentToFlush.length,
                "store.index": messageIndex,
                "ral.number": this.config.ralNumber,
                "agent.slug": context.agent.slug,
            });

            // Clear buffer BEFORE async publish to prevent re-adding on retry
            this.contentBuffer = "";

            try {
                const event = await context.agentPublisher.conversation(
                    { content: contentToFlush },
                    eventContext
                );

                // Link the published eventId to the message for loopback deduplication
                if (event.id && messageIndex >= 0) {
                    context.conversationStore.setEventId(messageIndex, event.id);
                }
            } catch (publishError) {
                // Log but don't throw - message is already in store, just unlinked
                // The loopback dedup will handle this gracefully (worst case: duplicate display)
                logger.warn("[StreamExecutionHandler] Failed to publish content buffer", {
                    error: publishError instanceof Error ? publishError.message : String(publishError),
                    ralNumber: this.config.ralNumber,
                    agent: context.agent.slug,
                });
            }
        }
    }

    /**
     * Handle stream errors
     */
    private async handleStreamError(streamError: unknown, abortSignal: AbortSignal): Promise<void> {
        const { context } = this.config;
        const ralNumber = this.config.ralNumber;

        await this.flushStreamTextDeltas({
            force: true,
            reason: "handle-stream-error",
        });

        if (abortSignal.aborted && abortSignal.reason === NO_RESPONSE_ABORT_REASON) {
            this.executionSpan?.addEvent("executor.silent_completion_short_circuit", {
                "ral.number": ralNumber,
                "agent.slug": context.agent.slug,
                "conversation.id": shortenConversationId(context.conversationId),
            });
            logger.info("[StreamExecutionHandler] Execution short-circuited by no_response", {
                agent: context.agent.slug,
                ralNumber,
                conversationId: context.conversationId.substring(0, 8),
            });

            this.ensureSilentCompletionResult("stream-error-abort");
            return;
        }

        if (abortSignal.aborted) {
            this.executionSpan?.addEvent("executor.aborted_by_stop_signal", {
                "ral.number": ralNumber,
                "agent.slug": context.agent.slug,
                "conversation.id": shortenConversationId(context.conversationId),
            });
            logger.info("[StreamExecutionHandler] Execution aborted by stop signal", {
                agent: context.agent.slug,
                ralNumber,
                conversationId: context.conversationId.substring(0, 8),
            });
            throw streamError;
        }

        if (this.result?.kind !== "error-handled") {
            this.result = { kind: "error-handled" };
            try {
                const { message: errorMessage, errorType } = formatStreamError(streamError);
                const eventContext = this.createEventContext();
                await context.agentPublisher.error({ message: errorMessage, errorType }, eventContext);
            } catch (publishError) {
                logger.error("Failed to publish stream error event", {
                    error: formatAnyError(publishError),
                });
                // Re-throw so AgentExecutor can attempt its own fallback publication.
                throw streamError;
            }
        }
        // Return normally — execute() will return { kind: "error-handled" } so AgentExecutor
        // skips its own error publication (which would produce a duplicate).
    }

    /**
     * Cleanup after stream execution
     */
    private async cleanup(): Promise<void> {
        const { context, llmService } = this.config;
        const ralNumber = this.config.ralNumber;
        const ralRegistry = RALRegistry.getInstance();

        this.clearStreamTextDeltaTimer();

        ralRegistry.endLLMStream(context.agent.pubkey, context.conversationId, ralNumber);
        ralRegistry.setStreaming(context.agent.pubkey, context.conversationId, ralNumber, false);

        llmOpsRegistry.completeOperation(context);
        llmService.removeAllListeners();

        const currentSpan = trace.getActiveSpan();
        if (currentSpan) {
            clearLLMSpanId(currentSpan.spanContext().traceId);
        }
    }

    private enqueueStreamTextDelta(delta: string): void {
        if (delta.length === 0) {
            return;
        }

        this.streamTextDeltaBuffer += delta;
        if (this.streamTextDeltaTimer) {
            return;
        }

        this.streamTextDeltaTimer = setTimeout(() => {
            this.streamTextDeltaTimer = undefined;
            void this.flushStreamTextDeltas({
                force: false,
                reason: "throttle-window",
            });
        }, StreamExecutionHandler.STREAM_TEXT_DELTA_THROTTLE_MS);
    }

    private clearStreamTextDeltaTimer(): void {
        if (this.streamTextDeltaTimer) {
            clearTimeout(this.streamTextDeltaTimer);
            this.streamTextDeltaTimer = undefined;
        }
    }

    private flushStreamTextDeltas(options: { force: boolean; reason: string }): Promise<void> {
        this.streamTextDeltaFlushChain = this.streamTextDeltaFlushChain
            .then(async () => {
                if (options.force) {
                    this.clearStreamTextDeltaTimer();
                }

                if (this.streamTextDeltaBuffer.length === 0) {
                    return;
                }

                const eventContext = this.streamTextDeltaEventContext;
                if (!eventContext) {
                    this.streamTextDeltaBuffer = "";
                    return;
                }

                const deltaToPublish = this.streamTextDeltaBuffer;
                this.streamTextDeltaBuffer = "";
                this.streamTextDeltaSequence += 1;

                this.executionSpan?.addEvent("executor.stream_delta_flush", {
                    "delta.sequence": this.streamTextDeltaSequence,
                    "delta.length": deltaToPublish.length,
                    "delta.reason": options.reason,
                    "ral.number": this.config.ralNumber,
                });

                await this.config.context.agentPublisher.streamTextDelta(
                    {
                        delta: deltaToPublish,
                        sequence: this.streamTextDeltaSequence,
                    },
                    eventContext
                );
            })
            .catch((error) => {
                logger.warn("[StreamExecutionHandler] Failed to flush stream text deltas", {
                    error: formatAnyError(error),
                    conversationId: shortenConversationId(this.config.context.conversationId),
                    agent: this.config.context.agent.slug,
                    ralNumber: this.config.ralNumber,
                });
            });

        return this.streamTextDeltaFlushChain;
    }

    private ensureSilentCompletionResult(source: string): void {
        if (this.result) {
            return;
        }

        this.executionSpan?.addEvent("executor.silent_completion_result_synthesized", {
            "ral.number": this.config.ralNumber,
            "agent.slug": this.config.context.agent.slug,
            "conversation.id": shortenConversationId(this.config.context.conversationId),
            "silent_completion.source": source,
        });

        this.result = {
            kind: "complete",
            event: {
                message: "",
                steps: [],
                usage: {
                    inputTokens: 0,
                    inputTokenDetails: {
                        noCacheTokens: 0,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                    },
                    outputTokens: 0,
                    outputTokenDetails: {
                        textTokens: 0,
                        reasoningTokens: 0,
                    },
                    totalTokens: 0,
                },
                finishReason: "stop",
            },
            messageCompiler: this.config.messageCompiler,
            accumulatedRuntime: 0,
        };
    }

    private requestSilentTermination(): void {
        if (this.silentTerminationRequested) {
            return;
        }

        this.silentTerminationRequested = true;
        this.contentBuffer = "";
        this.reasoningBuffer = "";
        this.streamTextDeltaBuffer = "";
        this.clearStreamTextDeltaTimer();

        this.executionSpan?.addEvent("executor.silent_completion_abort_requested", {
            "ral.number": this.config.ralNumber,
            "agent.slug": this.config.context.agent.slug,
            "conversation.id": shortenConversationId(this.config.context.conversationId),
        });

        if (!this.internalAbortController.signal.aborted) {
            this.internalAbortController.abort(NO_RESPONSE_ABORT_REASON);
        }
    }

    private combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
        const controller = new AbortController();

        const abortFrom = (signal: AbortSignal): void => {
            if (controller.signal.aborted) {
                return;
            }
            controller.abort(signal.reason);
        };

        for (const signal of signals) {
            if (signal.aborted) {
                abortFrom(signal);
                break;
            }

            signal.addEventListener(
                "abort",
                () => {
                    abortFrom(signal);
                },
                { once: true }
            );
        }

        return controller.signal;
    }
}
