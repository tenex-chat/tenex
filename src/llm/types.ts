import type { DefaultEventMap } from "tseep";

// Export AI SDK types directly
export type {
    ModelMessage,
    Tool as CoreTool,
    GenerateTextResult,
    StreamTextResult,
    // Multimodal content types
    UserContent,
    ImagePart,
    TextPart,
    FilePart,
} from "ai";

// Export execution context type
import type { ExecutionContext } from "@/agents/execution/types";
import type { LanguageModelUsage } from "ai";
import { PROVIDER_IDS } from "./providers/provider-ids";
export type { ExecutionContext };

/**
 * AI SDK supported providers
 * Derived from PROVIDER_IDS to prevent magic string duplication
 */
export const AI_SDK_PROVIDERS = [
    PROVIDER_IDS.OPENROUTER,
    PROVIDER_IDS.ANTHROPIC,
    PROVIDER_IDS.OPENAI,
    PROVIDER_IDS.OLLAMA,
    PROVIDER_IDS.CLAUDE,
    PROVIDER_IDS.CODEX,
] as const;
export type AISdkProvider = (typeof AI_SDK_PROVIDERS)[number];

export type LanguageModelUsageWithCostUsd = LanguageModelUsage & {
    costUsd?: number;
    model?: string;
    /** Cached input tokens (from OpenRouter promptTokensDetails.cachedTokens) */
    cachedInputTokens?: number;
    /** Reasoning tokens (from OpenRouter completionTokensDetails.reasoningTokens) */
    reasoningTokens?: number;
    /** Model context window size in tokens */
    contextWindow?: number;
};

export interface LLMMetadata {
    threadId?: string;
    turnId?: string;
    toolTotalCalls?: number;
    toolTotalDurationMs?: number;
    toolCommandCalls?: number;
    toolFileChangeCalls?: number;
    toolMcpCalls?: number;
    toolWebSearchCalls?: number;
    toolOtherCalls?: number;
}

/**
 * Callback invoked when message injection completes
 * @param delivered - true if the message was successfully delivered to the stream
 */
export type MessageInjectionCallback = (delivered: boolean) => void;

/**
 * Interface for providers that support mid-stream message injection.
 */
export interface MessageInjector {
    inject(message: string, callback: MessageInjectionCallback): void;
}

/**
 * Callback invoked when a stream starts, providing the message injector.
 * Used by agent providers that support mid-stream message injection.
 */
export type OnStreamStartCallback = (injector: MessageInjector) => void;

// ============================================================================
// LLMService Event Types
// ============================================================================

import type { AISdkTool } from "@/tools/types";
import type { StepResult, TextStreamPart } from "ai";

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
    metadata?: LLMMetadata;
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

export type LLMServiceEventMap = DefaultEventMap & {
    "raw-chunk": (...args: [event: RawChunkEvent]) => void;
    "chunk-type-change": (...args: [event: ChunkTypeChangeEvent]) => void;
    "content": (...args: [event: ContentEvent]) => void;
    "reasoning": (...args: [event: ReasoningEvent]) => void;
    "stream-error": (...args: [event: StreamErrorEvent]) => void;
    "tool-will-execute": (...args: [event: ToolWillExecuteEvent]) => void;
    "tool-did-execute": (...args: [event: ToolDidExecuteEvent]) => void;
    "complete": (...args: [event: CompleteEvent]) => void;
};
