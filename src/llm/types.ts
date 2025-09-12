// Export AI SDK types directly
export type { 
  ModelMessage,
  Tool as CoreTool,
  ToolCall as CoreToolCall,
  ToolResult as CoreToolResult,
  GenerateTextResult,
  StreamTextResult
} from 'ai';

// Export execution context type
import type { ExecutionContext } from "@/agents/execution/types";
import type { LanguageModelUsage } from 'ai';
export type { ExecutionContext };

/**
 * AI SDK supported providers
 * Note: claudeCode is a limited provider (phase-0 only in Track 1)
 */
export const AI_SDK_PROVIDERS = ["openrouter", "anthropic", "openai", "ollama", "claudeCode"] as const;
export type AISdkProvider = (typeof AI_SDK_PROVIDERS)[number];

/**
 * LLM Provider type alias for compatibility
 */
export type LLMProvider = AISdkProvider;

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

/**
 * Event kinds used in the TENEX system
 * 
 * Don't add kinds here if they are defined in NDKKind or if we have NDKEvent wrappers (i.e. don't add NDKKind.GenericReply or NDKProject.kind)
 */
export const EVENT_KINDS = {
  PROJECT_STATUS: 24010, // Ephemeral event kind (not stored by relays) - consider regular/addressable kinds for persistence
  AGENT_REQUEST: 4133,
  TYPING_INDICATOR: 24111,
  TYPING_INDICATOR_STOP: 24112,
  STREAMING_RESPONSE: 21111,
  FORCE_RELEASE: 24019,
  AGENT_CONFIG_UPDATE: 24020,
  OPERATIONS_STATUS: 24133, // LLM operations status (one per event being processed)
} as const;

