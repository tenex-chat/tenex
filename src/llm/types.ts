import type { DefaultEventMap } from "tseep";

// Export AI SDK types directly
export type {
    ModelMessage,
    Tool as CoreTool,
    ToolChoice,
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
import type { LanguageModelUsage, ModelMessage, Tool as CoreTool, ToolChoice } from "ai";
import type { SharedV3ProviderOptions as ProviderOptions } from "@ai-sdk/provider";
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
    PROVIDER_IDS.CODEX,
    PROVIDER_IDS.CLAUDE_CODE,
] as const;
export type AISdkProvider = (typeof AI_SDK_PROVIDERS)[number];

export interface ContextManagementAppliedEdit {
    type: string;
    clearedToolUses?: number;
    clearedInputTokens?: number;
    clearedThinkingTurns?: number;
}

export interface ContextManagementResponse {
    appliedEdits?: ContextManagementAppliedEdit[];
}

export type LanguageModelUsageWithCostUsd = LanguageModelUsage & {
    costUsd?: number;
    model?: string;
    /** Cached input tokens (from OpenRouter promptTokensDetails.cachedTokens) */
    cachedInputTokens?: number;
    /** Reasoning tokens (from OpenRouter completionTokensDetails.reasoningTokens) */
    reasoningTokens?: number;
    /** Model context window size in tokens */
    contextWindow?: number;
    /** Context management data from Anthropic API */
    contextManagement?: ContextManagementResponse;
};

export interface LLMMetadata {
    threadId?: string;
    turnId?: string;
    toolTotalCalls?: number;
    toolTotalDurationMs?: number;
    toolCommandCalls?: number;
    toolFileChangeCalls?: number;
    toolMcpCalls?: number;
    toolOtherCalls?: number;
}

/**
 * Callback invoked when message injection completes
 * @param delivered - true if the message was successfully delivered to the stream
 */
export type MessageInjectionCallback = (delivered: boolean) => void;

export interface LLMPreparedPromptMetrics {
    preContextEstimatedInputTokens?: number;
    sentEstimatedInputTokens?: number;
    estimatedInputTokensSaved?: number;
}

export interface LLMPromptCachingDiagnostics {
    sharedPrefixBreakpointApplied?: boolean;
    sharedPrefixMessageCount?: number;
    sharedPrefixLastMessageIndex?: number;
}

export interface LLMRequestAnalysisSeed {
    requestId: string;
    telemetryMetadata: Record<string, string | number | boolean>;
    preparedPromptMetrics?: LLMPreparedPromptMetrics;
    promptCachingDiagnostics?: LLMPromptCachingDiagnostics;
}

export interface InvalidToolCall {
    stepNumber: number;
    toolCallIndex: number;
    toolName: string;
    toolCallId?: string;
    errorType: string;
    errorMessage: string;
    input?: unknown;
}

export interface LLMAnalysisRequestHandle {
    requestId: string;
    telemetryMetadata: Record<string, string | number | boolean>;
    reportSuccess: (params: {
        completedAt: number;
        usage?: LanguageModelUsageWithCostUsd;
        finishReason?: string;
        metadata?: LLMMetadata;
    }) => Promise<void> | void;
    reportError: (params: {
        completedAt: number;
        error: unknown;
    }) => Promise<void> | void;
    reportInvalidToolCalls: (params: {
        invalidToolCalls: InvalidToolCall[];
        recordedAt?: number;
    }) => Promise<void> | void;
}

export interface LLMAnalysisHooks {
    openRequest: (params: {
        operationKind: "stream" | "generate-text" | "generate-object";
        startedAt: number;
        provider: string;
        model: string;
        apiKeyIdentity?: string;
        messages: ModelMessage[];
        providerOptions?: ProviderOptions;
        toolChoice?: ToolChoice<Record<string, CoreTool>>;
        requestSeed?: LLMRequestAnalysisSeed;
    }) => Promise<LLMAnalysisRequestHandle | undefined> | LLMAnalysisRequestHandle | undefined;
}

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
    usedErrorFallback?: boolean;
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
