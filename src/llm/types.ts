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
 */
export const AI_SDK_PROVIDERS = [
    "openrouter",
    "anthropic",
    "openai",
    "ollama",
    "claudeCode",
    "gemini-cli",
] as const;
export type AISdkProvider = (typeof AI_SDK_PROVIDERS)[number];

/**
 * LLM Provider type alias for compatibility
 */
export type LLMProvider = AISdkProvider;

/**
 * Provider configuration
 */
export interface ProviderConfig {
    provider: AISdkProvider;
    streaming?: boolean; // Whether this provider supports true streaming
}

/**
 * Model configuration
 */
export interface ModelConfig {
    provider: AISdkProvider;
    model: string;
    temperature?: number;
    maxTokens?: number;
}

export type LanguageModelUsageWithCostUsd = LanguageModelUsage & {
    costUsd?: number;
    model?: string;
};
