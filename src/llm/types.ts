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
export type { ExecutionContext };

/**
 * AI SDK supported providers
 */
export const AI_SDK_PROVIDERS = ["openrouter", "anthropic", "openai", "ollama"] as const;
export type AISdkProvider = (typeof AI_SDK_PROVIDERS)[number];

/**
 * Model configuration
 */
export interface ModelConfig {
  provider: AISdkProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Event kinds used in the TENEX system
 * 
 * Don't add kinds here if they are defined in NDKKind or if we have NDKEvent wrappers (i.e. don't add NDKKind.GenericReply or NDKProject.kind)
 */
export const EVENT_KINDS = {
  PROJECT_STATUS: 24010,
  AGENT_REQUEST: 4133,
  TYPING_INDICATOR: 24111,
  TYPING_INDICATOR_STOP: 24112,
  STREAMING_RESPONSE: 21111,
  FORCE_RELEASE: 24019,
  AGENT_CONFIG_UPDATE: 24020,
} as const;

