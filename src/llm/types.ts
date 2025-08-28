export interface ModelSelectionResult {
  model: string;
  supportsCaching: boolean;
}

export interface ConfigurationPrompts {
  configName: string;
  enableCaching?: boolean;
  setAsDefault: boolean;
}

export interface ApiKeyResult {
  apiKey: string;
  isNew: boolean;
}

/**
 * Clean LLM types with single responsibility
 * No agent or orchestration concerns
 */

import type {
  LlmCompletionOpts,
  Message,
  LlmResponse,
} from "multi-llm-ts";

// Extend LlmResponse to include model information
export type CompletionResponse = LlmResponse & { model?: string };

// Re-export for convenience
export type { Message } from "multi-llm-ts";
export type { LlmToolCall as ToolCall } from "multi-llm-ts";

// Extended completion options with routing context
export interface CompletionOptions extends LlmCompletionOpts {
  configName?: string;
  agentName?: string;
}

// Import and re-export tool types
import type { ExecutionContext, Tool } from "@/tools/types";
export type { Tool, ExecutionContext };

// Simplified completion request that uses multi-llm-ts types
export interface CompletionRequest {
  messages: Message[];
  options?: CompletionOptions;
  tools?: Tool[];
  toolContext?: ExecutionContext;
}

// Streaming types
export type StreamEvent =
  | { type: "content"; content: string }
  | { type: "tool_start"; tool: string; args: Record<string, unknown> }
  | { type: "tool_complete"; tool: string; result: unknown }
  | { type: "error"; error: string }
  | { type: "done"; response: CompletionResponse };

/**
 * Pure LLM service interface - single responsibility
 */
export interface LLMService {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  stream(request: CompletionRequest): AsyncIterable<StreamEvent>;
}

/**
 * LLM Model Configuration - matches what's stored on disk in TenexLLMs.configurations
 * Does NOT include credentials (apiKey, baseUrl) which are stored separately
 */
export interface LLMModelConfig {
  provider: LLMProvider;
  model: string;
  enableCaching?: boolean;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Resolved LLM Configuration - includes credentials for runtime use
 * This is what the LLM service actually needs to make API calls
 */
export interface ResolvedLLMConfig extends LLMModelConfig {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

/**
 * Named LLM configuration for UI display and management
 */
export interface LLMConfigWithName extends ResolvedLLMConfig {
  name: string;
}

/**
 * LLM Provider types
 */
export const LLM_PROVIDERS = [
  "openai",
  "openrouter",
  "anthropic",
  "google",
  "groq",
  "deepseek",
  "ollama",
  "mistral",
  "openai-compatible",
] as const;

export type LLMProvider = (typeof LLM_PROVIDERS)[number];

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

/**
 * Provider authentication
 */
export interface ProviderAuth {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}
