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

// AI SDK v5 doesn't export ToolCall/ToolResult as separate types
// Tool calls are part of the streaming response types
// Define compatibility types for internal use (legacy mock LLM support)
export interface ToolCall {
    name?: string;
    function?: string;
    params?: Record<string, unknown>;
    args?: string | Record<string, unknown>;
}

export interface Message {
    role: string;
    content: string;
}

export interface CompletionRequest {
    messages: Message[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
    options?: {
        configName?: string;
        [key: string]: unknown;
    };
}

export interface CompletionResponse {
    content?: string;
    toolCalls?: ToolCall[];
    model?: string;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    experimental_providerMetadata?: Record<string, unknown>;
}

export interface StreamEvent {
    type: string;
    content?: string;
    delta?: string;
    error?: string;
    tool?: string;
    args?: unknown;
    response?: {
        type: string;
        content?: string;
        toolCalls?: ToolCall[];
        usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
        };
    };
}

export interface LLMService {
    complete(request: CompletionRequest): Promise<CompletionResponse>;
    stream?(request: CompletionRequest): AsyncIterableIterator<StreamEvent>;
}

// Export execution context type
import type { ExecutionContext } from "@/agents/execution/types";
import type { LanguageModelUsage } from "ai";
export type { ExecutionContext };

/**
 * AI SDK supported providers
 * Note: Provider IDs use kebab-case consistently
 */
export const AI_SDK_PROVIDERS = [
    "openrouter",
    "anthropic",
    "openai",
    "ollama",
    "claude-code",
    "gemini-cli",
    "codex-app-server",
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

/**
 * Chunk sent over local streaming socket
 */
export interface LocalStreamChunk {
    /** Hex pubkey of the agent generating this response */
    agent_pubkey: string;
    /** Root event ID of the conversation (hex) */
    conversation_id: string;
    /** Raw AI SDK chunk - passthrough without transformation */
    data: unknown;
}

/**
 * Callback invoked when message injection completes
 * @param delivered - true if the message was successfully delivered to the stream
 */
export type MessageInjectionCallback = (delivered: boolean) => void;

/**
 * Interface for injecting messages into an active Claude Code stream.
 * This allows mid-execution message delivery without restarting the stream.
 */
export interface MessageInjector {
    /**
     * Inject a user message into the active stream.
     * The message will be delivered between tool calls (not during continuous text).
     * @param content - The message content to inject
     * @param onDelivered - Optional callback invoked when delivery completes
     */
    inject(content: string, onDelivered?: MessageInjectionCallback): void;
}

/**
 * Callback invoked when a stream starts, providing the message injector.
 * Used by agent providers that support mid-stream message injection.
 */
export type OnStreamStartCallback = (injector: MessageInjector) => void;
