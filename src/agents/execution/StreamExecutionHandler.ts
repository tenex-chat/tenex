/**
 * StreamExecutionHandler - Handles LLM streaming execution with event processing
 *
 * This class encapsulates stream event handling and coordinates
 * LLM streaming with message persistence and delegation handling.
 * Callbacks are created via StreamCallbacks module.
 */

import { formatAnyError, formatStreamError } from "@/lib/error-formatter";
import {
    type ChunkTypeChangeEvent,
    type CompleteEvent,
    type ContentEvent,
    type RawChunkEvent,
    type ReasoningEvent,
    type SessionCapturedEvent,
    type StreamErrorEvent,
} from "@/llm/types";
import { streamPublisher } from "@/llm";
import { PROVIDER_IDS } from "@/llm/providers/provider-ids";
import type { EventContext } from "@/nostr/types";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { RALRegistry } from "@/services/ral";
import { clearLLMSpanId } from "@/telemetry/LLMSpanRegistry";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type { LanguageModel, ModelMessage } from "ai";
import chalk from "chalk";
import type { LLMService } from "@/llm/service";
import type { MessageCompiler } from "./MessageCompiler";
import type { SessionManager } from "./SessionManager";
import type { ToolExecutionTracker } from "./ToolExecutionTracker";
import { createPrepareStep, createOnStopCheck } from "./StreamCallbacks";
import { setupToolEventHandlers } from "./ToolEventHandlers";
import type { FullRuntimeContext, RALExecutionContext, StreamExecutionResult } from "./types";
import { extractLastUserMessage } from "./utils";

/**
 * Configuration for stream execution
 */
export interface StreamExecutionConfig {
    context: FullRuntimeContext;
    toolTracker: ToolExecutionTracker;
    ralNumber: number;
    toolsObject: Record<string, AISdkTool>;
    sessionManager: SessionManager;
    llmService: LLMService;
    messageCompiler: MessageCompiler;
    nudgeContent: string;
    ephemeralMessages: Array<{ role: "user" | "system"; content: string }>;
    abortSignal: AbortSignal;
    metaModelSystemPrompt?: string;
    variantSystemPrompt?: string;
}

/**
 * Handles all LLM stream event processing and coordination
 */
export class StreamExecutionHandler {
    private contentBuffer = "";
    private reasoningBuffer = "";
    private result: StreamExecutionResult | undefined;
    private lastUsedVariant: string | undefined;
    private currentModel: LanguageModel | undefined;
    private readonly execContext: RALExecutionContext;
    private readonly executionSpan = trace.getActiveSpan();

    constructor(private readonly config: StreamExecutionConfig) {
        this.lastUsedVariant = config.context.conversationStore.getMetaModelVariantOverride(
            config.context.agent.pubkey
        );
        this.execContext = { accumulatedMessages: [] };
    }

    /**
     * Execute the stream and return the result
     */
    async execute(messages: ModelMessage[]): Promise<StreamExecutionResult> {
        const { context, llmService, toolsObject, abortSignal } = this.config;
        const ralRegistry = RALRegistry.getInstance();
        const conversationStore = context.conversationStore;
        const ralNumber = this.config.ralNumber;

        // Initialize execution context
        this.execContext.accumulatedMessages = messages;

        // Setup all event handlers
        this.setupEventHandlers();

        try {
            // Mark this RAL as streaming and start timing LLM runtime
            ralRegistry.setStreaming(context.agent.pubkey, context.conversationId, ralNumber, true);
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
                    "tenex.conversation.id": context.conversationId,
                    "tenex.ral.number": ralNumber,
                    "tenex.delegation.chain":
                        conversationStore.metadata.delegationChain
                            ?.map((e) => e.displayName)
                            .join(" -> ") ?? "",
                });
            }

            // Subscribe to raw chunks and forward to local streaming socket
            llmService.on("raw-chunk", (event: RawChunkEvent) => {
                logger.debug("[StreamExecutionHandler] raw-chunk received", {
                    chunkType: event.chunk.type,
                    agentPubkey: context.agent.pubkey.substring(0, 8),
                });
                streamPublisher.write({
                    agent_pubkey: context.agent.pubkey,
                    conversation_id: context.conversationId,
                    data: event.chunk,
                });
            });

            // Create callbacks using extracted factory functions
            const prepareStep = createPrepareStep({
                context,
                llmService,
                messageCompiler: this.config.messageCompiler,
                ephemeralMessages: this.config.ephemeralMessages,
                nudgeContent: this.config.nudgeContent,
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

            const onStopCheck = createOnStopCheck({
                context,
                ralNumber,
                execContext: this.execContext,
                executionSpan: this.executionSpan,
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
                abortSignal,
                prepareStep,
                onStopCheck,
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
            await this.handleStreamError(streamError, abortSignal);
        } finally {
            await this.cleanup();
        }

        // Flush any remaining reasoning buffer
        if (this.reasoningBuffer.trim().length > 0) {
            await this.flushReasoningBuffer();
        }

        // Handle session persistence for Claude Code
        const { sessionManager, llmService: svc } = this.config;
        if (
            !sessionManager.getSession().sessionId &&
            svc.provider === PROVIDER_IDS.CLAUDE_CODE &&
            this.result?.kind === "complete"
        ) {
            sessionManager.saveLastSentEventId(context.triggeringEvent.id);
        }

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
                "conversation.id": context.conversationId.substring(0, 8),
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
        const ralNumber = this.config.ralNumber;

        llmService.on("content", (event: ContentEvent) => {
            process.stdout.write(chalk.white(event.delta));
            this.contentBuffer += event.delta;
        });

        llmService.on("reasoning", (event: ReasoningEvent) => {
            process.stdout.write(chalk.gray(event.delta));
            this.reasoningBuffer += event.delta;
        });

        llmService.on("chunk-type-change", async (event: ChunkTypeChangeEvent) => {
            if (event.from === "reasoning-delta") {
                await this.flushReasoningBuffer();
            }
            if (event.from === "text-delta") {
                await this.flushContentBuffer();
            }
        });

        // Track when we register the complete listener
        const completeListenerRegisteredAt = Date.now();
        this.executionSpan?.addEvent("executor.complete_listener_registered", {
            "listener.registered_at": completeListenerRegisteredAt,
            "ral.number": ralNumber,
        });

        llmService.on("complete", (event: CompleteEvent) => {
            const completeReceivedTime = Date.now();
            const timeSinceRegistration = completeReceivedTime - completeListenerRegisteredAt;
            this.executionSpan?.addEvent("executor.complete_received", {
                "complete.received_at": completeReceivedTime,
                "complete.ms_since_listener_registered": timeSinceRegistration,
                "complete.message_length": event.message?.length ?? 0,
                "complete.steps_count": event.steps?.length ?? 0,
                "complete.finish_reason": event.finishReason ?? "unknown",
                "complete.result_already_set": this.result !== undefined,
                "complete.result_kind": this.result?.kind ?? "none",
                "ral.number": ralNumber,
            });

            if (!this.result) {
                this.result = {
                    kind: "complete",
                    event,
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

        llmService.on("session-captured", ({ sessionId: capturedSessionId }: SessionCapturedEvent) => {
            this.config.sessionManager.saveSession(capturedSessionId, context.triggeringEvent.id);
        });

        // Setup tool event handlers via extracted module
        setupToolEventHandlers({
            context,
            llmService,
            toolTracker,
            toolsObject,
            eventContext,
            ralNumber,
        });
    }

    /**
     * Create event context for publishing
     */
    private createEventContext(): EventContext {
        const { context, llmService } = this.config;
        const { createEventContext } = require("@/utils/event-context");
        const eventContext = createEventContext(context, llmService.model);

        // DIAGNOSTIC: Track event context creation to debug llm-ral=0 issues
        this.executionSpan?.addEvent("executor.event_context_created", {
            "context.ral_number": eventContext.ralNumber,
            "context.conversation_id": eventContext.conversationId?.substring(0, 8) ?? "none",
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
            const eventContext = this.createEventContext();
            await this.config.context.agentPublisher.conversation(
                { content: this.reasoningBuffer, isReasoning: true },
                eventContext
            );
            this.reasoningBuffer = "";
        }
    }

    /**
     * Flush content buffer to publish interim text
     */
    private async flushContentBuffer(): Promise<void> {
        if (this.contentBuffer.trim().length > 0) {
            const eventContext = this.createEventContext();
            await this.config.context.agentPublisher.conversation(
                { content: this.contentBuffer },
                eventContext
            );
            this.contentBuffer = "";
        }
    }

    /**
     * Handle stream errors
     */
    private async handleStreamError(streamError: unknown, abortSignal: AbortSignal): Promise<void> {
        const { context } = this.config;
        const ralNumber = this.config.ralNumber;

        if (abortSignal.aborted) {
            this.executionSpan?.addEvent("executor.aborted_by_stop_signal", {
                "ral.number": ralNumber,
                "agent.slug": context.agent.slug,
                "conversation.id": context.conversationId,
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
            }
        }
        throw streamError;
    }

    /**
     * Cleanup after stream execution
     */
    private async cleanup(): Promise<void> {
        const { context, llmService } = this.config;
        const ralNumber = this.config.ralNumber;
        const ralRegistry = RALRegistry.getInstance();

        ralRegistry.endLLMStream(context.agent.pubkey, context.conversationId, ralNumber);
        ralRegistry.setStreaming(context.agent.pubkey, context.conversationId, ralNumber, false);

        llmOpsRegistry.completeOperation(context);
        llmService.removeAllListeners();

        const currentSpan = trace.getActiveSpan();
        if (currentSpan) {
            clearLLMSpanId(currentSpan.spanContext().traceId);
        }
    }
}
