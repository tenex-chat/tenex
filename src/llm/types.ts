// Export AI SDK types directly
export type { 
  ModelMessage,
  Tool as CoreTool,
  ToolCall as CoreToolCall,
  ToolResult as CoreToolResult,
  GenerateTextResult,
  StreamTextResult
} from "ai";

// Export execution context type
import type { ExecutionContext } from "@/agents/execution/types";
import type { LanguageModelUsage } from "ai";
export type { ExecutionContext };

/**
 * AI SDK supported providers
 */
export const AI_SDK_PROVIDERS = ["openrouter", "anthropic", "openai", "ollama", "claudeCode", "gemini-cli"] as const;
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
  streaming?: boolean;  // Whether this provider supports true streaming
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

export type LanguageModelUsageWithCostUsd = LanguageModelUsage & { costUsd?: number };

