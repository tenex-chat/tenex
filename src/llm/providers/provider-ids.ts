/**
 * Provider ID constants
 *
 * These constants are the canonical source of truth for provider IDs.
 * Use these instead of magic strings to prevent typos and mismatches.
 */

export const PROVIDER_IDS = {
    CLAUDE_CODE: "claude-code",
    CODEX_APP_SERVER: "codex-app-server",
    GEMINI_CLI: "gemini-cli",
    OPENROUTER: "openrouter",
    ANTHROPIC: "anthropic",
    OPENAI: "openai",
    OLLAMA: "ollama",
    MOCK: "mock",
} as const;

export type ProviderId = (typeof PROVIDER_IDS)[keyof typeof PROVIDER_IDS];
