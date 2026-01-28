import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type {
    StepResult,
    StreamTextOnFinishCallback,
} from "ai";
import type { EventEmitter } from "tseep";
import { PROVIDER_IDS } from "./providers/provider-ids";
import { getInvalidToolCalls } from "./utils/tool-errors";
import { extractUsageMetadata, extractOpenRouterGenerationId } from "./providers/usage-metadata";
import type { LLMServiceEventMap } from "./types";

export interface FinishHandlerConfig {
    provider: string;
    model: string;
    getModelContextWindow: () => number | undefined;
}

export interface FinishHandlerState {
    getCachedContent: () => string;
    clearCachedContent: () => void;
    getLastUserMessage: () => string | undefined;
    clearLastUserMessage: () => void;
}

/**
 * Creates the onFinish handler for LLM streaming.
 * Extracted from LLMService to reduce file size.
 */
export function createFinishHandler(
    emitter: EventEmitter<LLMServiceEventMap>,
    config: FinishHandlerConfig,
    state: FinishHandlerState
): StreamTextOnFinishCallback<Record<string, AISdkTool>> {
    return async (e) => {
        const onFinishStartTime = Date.now();
        const activeSpan = trace.getActiveSpan();

        // DIAGNOSTIC: Track onFinish lifecycle for debugging race conditions
        activeSpan?.addEvent("llm.onFinish_started", {
            "onFinish.start_time": onFinishStartTime,
            "onFinish.finish_reason": e.finishReason,
            "onFinish.steps_count": e.steps.length,
            "onFinish.text_length": e.text?.length ?? 0,
            "onFinish.cached_content_length": state.getCachedContent().length,
        });

        try {
            recordInvalidToolCalls(e.steps, "response", config.model, config.provider);

            // For streaming, use cached content only. Don't fall back to e.text.
            // When cachedContentForComplete is empty, it means all content was already
            // published via chunk-type-change events (interim text before tool calls).
            // Falling back to e.text would cause duplicate publishing.
            const finalMessage = state.getCachedContent();

            emitSessionCapturedFromMetadata(
                emitter,
                config.provider,
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
                config.provider,
                config.model,
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

            emitter.emit("complete", {
                message: finalMessage,
                steps: e.steps,
                usage: {
                    ...usage,
                    contextWindow: config.getModelContextWindow(),
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
            const lastUserMessage = state.getLastUserMessage();
            if (lastUserMessage) {
                const truncatedPrompt = lastUserMessage.length > 2000
                    ? lastUserMessage.substring(0, 2000) + "... [truncated]"
                    : lastUserMessage;
                activeSpan?.addEvent("llm.prompt", {
                    "prompt.text": truncatedPrompt,
                    "prompt.full_length": lastUserMessage.length,
                    "prompt.truncated": lastUserMessage.length > 2000,
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
            state.clearCachedContent();
            state.clearLastUserMessage();
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

/**
 * Record invalid tool calls to the active span
 */
function recordInvalidToolCalls(
    steps: StepResult<Record<string, AISdkTool>>[],
    logContext: "complete" | "response",
    model: string,
    provider: string
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
        model,
        provider,
    });
}

/**
 * Emit session-captured event from provider metadata
 */
function emitSessionCapturedFromMetadata(
    emitter: EventEmitter<LLMServiceEventMap>,
    provider: string,
    providerMetadata: Record<string, unknown> | undefined,
    recordSpanEvent: boolean
): void {
    if (provider === PROVIDER_IDS.CODEX_APP_SERVER) {
        const sessionId = (
            providerMetadata?.[PROVIDER_IDS.CODEX_APP_SERVER] as { sessionId?: string } | undefined
        )?.sessionId;
        if (sessionId) {
            if (recordSpanEvent) {
                trace.getActiveSpan()?.addEvent("llm.session_captured", {
                    "session.id": sessionId,
                });
            }
            emitter.emit("session-captured", { sessionId });
        }
    }
}
