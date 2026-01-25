import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type { TextStreamPart } from "ai";
import type { EventEmitter } from "tseep";
import { shouldIgnoreChunk } from "./chunk-validators";
import type { LanguageModelUsageWithCostUsd } from "./types";

/**
 * Events emitted by the LLM service for chunk handling
 */
export interface ChunkHandlerEvents {
    "raw-chunk": { chunk: TextStreamPart<Record<string, AISdkTool>> };
    "chunk-type-change": { from: string; to: string };
    "content": { delta: string };
    "reasoning": { delta: string };
    "stream-error": { error: unknown };
    "tool-will-execute": {
        toolName: string;
        toolCallId: string;
        args: unknown;
        usage?: {
            inputTokens: number;
            outputTokens: number;
            contextWindow?: number;
        };
    };
    "tool-did-execute": {
        toolName: string;
        toolCallId: string;
        result: unknown;
        error?: boolean;
    };
}

export interface ChunkHandlerState {
    previousChunkType?: string;
    cachedContentForComplete: string;
    getCurrentStepUsage: () => LanguageModelUsageWithCostUsd | undefined;
    getModelContextWindow: () => number | undefined;
}

/**
 * Handles streaming chunks from the LLM.
 * Extracted from LLMService to reduce file size.
 */
export class ChunkHandler {
    private state: ChunkHandlerState;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private emitter: EventEmitter<Record<string, any>>;

    constructor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        emitter: EventEmitter<Record<string, any>>,
        state: ChunkHandlerState
    ) {
        this.emitter = emitter;
        this.state = state;
    }

    /**
     * Main entry point for handling incoming chunks
     */
    handleChunk(event: { chunk: TextStreamPart<Record<string, AISdkTool>> }): void {
        const chunk = event.chunk;

        // Validate chunk before any processing - some LLMs send chunks that should be ignored
        if (shouldIgnoreChunk(chunk)) {
            return;
        }

        // Emit raw-chunk event for consumers (e.g., local streaming)
        logger.debug("[LLMService] emitting raw-chunk", { chunkType: chunk.type });
        this.emitter.emit("raw-chunk", { chunk: event.chunk });

        // Emit chunk-type-change event BEFORE processing the new chunk
        // This allows listeners to flush buffers before new content of a different type arrives
        if (this.state.previousChunkType !== undefined && this.state.previousChunkType !== chunk.type) {
            this.emitter.emit("chunk-type-change", {
                from: this.state.previousChunkType,
                to: chunk.type,
            });
            // Clear cached content after emitting chunk-type-change.
            // IMPORTANT: AgentExecutor listens to chunk-type-change and publishes the content
            // buffer as a kind:1 event BEFORE this clearing happens. Without that publish,
            // interim text (e.g., "I'll fetch that naddr...") would be lost.
            // See: src/agents/execution/AgentExecutor.ts chunk-type-change handler
            this.state.cachedContentForComplete = "";
        }

        // Update previousChunkType AFTER emitting the change event
        this.state.previousChunkType = chunk.type;

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
                this.handleToolError(chunk.toolCallId, chunk.toolName, chunk.error);
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
                this.emitter.emit("stream-error", { error: chunk.error });
                break;
            }
            default:
                // Record unknown chunk types for debugging
                trace.getActiveSpan()?.addEvent("llm.unknown_chunk_type", {
                    "chunk.type": chunk.type,
                });
        }
    }

    private handleTextDelta(text: string): void {
        this.emitter.emit("content", { delta: text });
        this.state.cachedContentForComplete += text;
    }

    private handleReasoningDelta(text: string): void {
        // Skip useless "[REDACTED]" reasoning events
        if (text.trim() === "[REDACTED]") {
            return;
        }
        this.emitter.emit("reasoning", { delta: text });
    }

    private handleToolCall(toolCallId: string, toolName: string, args: unknown): void {
        trace.getActiveSpan()?.addEvent("llm.tool_will_execute", {
            "tool.name": toolName,
            "tool.call_id": toolCallId,
        });
        const usage = this.state.getCurrentStepUsage();
        this.emitter.emit("tool-will-execute", {
            toolName,
            toolCallId,
            args,
            usage: usage
                ? { ...usage, contextWindow: this.state.getModelContextWindow() }
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

        this.emitter.emit("tool-did-execute", {
            toolName,
            toolCallId,
            result,
            error: hasError,
        });
    }

    private handleToolError(toolCallId: string, toolName: string, error: unknown): void {
        // Handle tool execution errors - emit as tool-did-execute with error flag
        const errorMsg =
            error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? (error as Error).stack : undefined;

        logger.error(`[LLMService] Tool '${toolName}' threw an error`, {
            toolCallId,
            toolName,
            error: errorMsg,
            stack: errorStack,
        });

        // Log BOTH error event AND execution complete event for consistency
        const activeSpan = trace.getActiveSpan();
        activeSpan?.addEvent("llm.tool_error", {
            "tool.name": toolName,
            "tool.call_id": toolCallId,
            "tool.error_message": errorMsg,
            "tool.error_type": error?.constructor?.name || "Error",
        });

        // IMPORTANT: Also log tool_did_execute for error cases
        // This ensures trace analysis can find tool completion regardless of success/failure
        activeSpan?.addEvent("llm.tool_did_execute", {
            "tool.name": toolName,
            "tool.call_id": toolCallId,
            "tool.error": true,
            "tool.error_message": errorMsg.substring(0, 200),
        });

        // Emit tool-did-execute with error info so it gets persisted to conversation
        // Format the error as a result object that the LLM can understand
        this.emitter.emit("tool-did-execute", {
            toolName,
            toolCallId,
            result: {
                type: "error-text",
                text: `Tool execution failed: ${errorMsg}`,
            },
            error: true,
        });
    }

    /**
     * Get the current cached content
     */
    getCachedContent(): string {
        return this.state.cachedContentForComplete;
    }

    /**
     * Clear the cached content
     */
    clearCachedContent(): void {
        this.state.cachedContentForComplete = "";
    }
}

/**
 * Check if a tool result indicates an error
 */
function isToolResultError(result: unknown): boolean {
    if (result && typeof result === "object") {
        const obj = result as Record<string, unknown>;
        return obj.type === "error-text" || obj.type === "error";
    }
    return false;
}

/**
 * Extract error details from a tool result
 */
function extractErrorDetails(result: unknown): { type: string; message: string } | undefined {
    if (result && typeof result === "object") {
        const obj = result as Record<string, unknown>;
        if (obj.type === "error-text" || obj.type === "error") {
            return {
                type: String(obj.type),
                message: String(obj.text || obj.message || "Unknown error"),
            };
        }
    }
    return undefined;
}
