import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type {
    StepResult,
    StreamTextOnFinishCallback,
} from "ai";
import type { EventEmitter } from "tseep";
import { getInvalidToolCalls } from "./utils/tool-errors";
import {
    extractLLMMetadata,
    extractOpenRouterGenerationId,
    extractUsageMetadata,
} from "./providers/usage-metadata";
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

export interface FinishHandlerOptions {
    onFinalStepInputTokens?: (
        actualInputTokens: number | null | undefined
    ) => Promise<void> | void;
}

/**
 * Creates the onFinish handler for LLM streaming.
 * Extracted from LLMService to reduce file size.
 */
export function createFinishHandler(
    emitter: EventEmitter<LLMServiceEventMap>,
    config: FinishHandlerConfig,
    state: FinishHandlerState,
    options?: FinishHandlerOptions
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

            // For streaming, use cached content if available.
            // When cachedContentForComplete is empty but e.text has content, it means:
            // - Content was already published as conversation event(s) via chunk-type-change
            // - BUT we still need to re-publish it in the completion event for delegations
            // This creates intentional duplication (conversation + completion both have same text)
            // but ensures delegated agents receive the full response via p-tag on completion.
            //
            // Multi-level fallback for finalMessage:
            // 1. Use cachedContent if available (normal case: text is still buffered)
            // 2. Use e.text if non-empty (text was already published via chunk-type-change,
            //    but we still re-publish for delegations - see comment above)
            // 3. Use accumulated steps text if non-empty (handles multi-step flows where
            //    the final step has no text - e.g., last step processed a tool result and
            //    stopped immediately; e.text = finalStep.text which is "" in that case,
            //    but the real response text is in an earlier step)
            // 4. Use error message if all sources are empty
            const ERROR_FALLBACK_MESSAGE =
                "There was an error capturing the work done, please review the conversation for the results";

            const cachedContent = state.getCachedContent();
            const text = e.text ?? "";
            const stepsText = e.steps.reduce((acc, step) => acc + step.text, "");

            const fallbackLevel =
                cachedContent.length > 0 ? "cached" :
                text.length > 0 ? "text" :
                stepsText.length > 0 ? "steps" :
                "error";

            const finalMessage =
                fallbackLevel === "cached" ? cachedContent :
                fallbackLevel === "text" ? text :
                fallbackLevel === "steps" ? stepsText :
                ERROR_FALLBACK_MESSAGE;

            const usedFallbackToText = fallbackLevel === "text";
            const usedErrorFallback = fallbackLevel === "error";

            // Capture OpenRouter generation ID for trace correlation
            const lastStep = e.steps.length > 0 ? e.steps[e.steps.length - 1] : undefined;
            const latestProviderMetadata =
                (lastStep?.providerMetadata ?? e.providerMetadata) as Record<string, unknown> | undefined;

            const openrouterGenerationId = extractOpenRouterGenerationId(latestProviderMetadata);
            if (openrouterGenerationId) {
                activeSpan?.setAttribute("openrouter.generation_id", openrouterGenerationId);
            }

            // Extract usage metadata from the most recent completed LLM step.
            // e.totalUsage is AI SDK's cumulative total across all steps, which would
            // cause Nostr events to report ever-growing token counts. Using the last
            // step's per-step usage gives accurate per-invocation values.
            // Falls back to e.totalUsage when steps is empty (e.g. in tests).
            const usage = extractUsageMetadata(
                config.provider,
                config.model,
                lastStep?.usage ?? e.totalUsage,
                latestProviderMetadata
            );

            await options?.onFinalStepInputTokens?.(usage.inputTokens);
            const metadata = extractLLMMetadata(config.provider, latestProviderMetadata);

            // DIAGNOSTIC: Log right before emitting complete event
            const beforeEmitTime = Date.now();
            activeSpan?.addEvent("llm.complete_will_emit", {
                "complete.message_length": finalMessage.length,
                "complete.cached_content_length": cachedContent.length,
                "complete.e_text_length": text.length,
                "complete.steps_text_length": stepsText.length,
                "complete.fallback_level": fallbackLevel,
                "complete.used_fallback_to_e_text": usedFallbackToText,
                "complete.used_error_fallback": usedErrorFallback,
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
                metadata,
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
                    ? `${lastUserMessage.substring(0, 2000)}... [truncated]`
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
                    ? `${e.text.substring(0, 4000)}... [truncated]`
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
            logger.writeToWarnLog({
                timestamp: new Date().toISOString(),
                level: "error",
                component: "FinishHandler",
                message: "Error in LLM onFinish handler",
                context: {
                    provider: config.provider,
                    model: config.model,
                    finishReason: e.finishReason,
                    stepsCount: e.steps.length,
                },
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
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
