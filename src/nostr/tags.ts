/**
 * Strongly typed Nostr tag definitions for consistency across the codebase
 */

// Status tags
export const STATUS_TAGS = {
  STATUS: "status",
  PROGRESS: "progress",
} as const;

// LLM-related tags - consistent prefix for all LLM metadata
export const LLM_TAGS = {
  MODEL: "llm-model",
  COST_USD: "llm-cost-usd",
  PROMPT_TOKENS: "llm-prompt-tokens",
  COMPLETION_TOKENS: "llm-completion-tokens",
  TOTAL_TOKENS: "llm-total-tokens",
  CONTEXT_WINDOW: "llm-context-window",
  MAX_COMPLETION_TOKENS: "llm-max-completion-tokens",
} as const;

// Session and execution tags
export const EXECUTION_TAGS = {
  SESSION_ID: "session-id",
  EXECUTOR: "executor",
  BRANCH: "branch",
  PROMPT: "prompt",
  NET_TIME: "net-time",
} as const;

// Claude-specific tags
export const CLAUDE_TAGS = {
  MESSAGE_TYPE: "claude-message-type",
  MESSAGE_ID: "claude-message-id",
  SESSION_ID: "claude-session-id",
} as const;
