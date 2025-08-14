/**
 * Global constants used throughout the TENEX codebase
 */

/**
 * Directory names
 */
export const TENEX_DIR = ".tenex" as const;
export const CONVERSATIONS_DIR = "conversations" as const;

/**
 * File names
 */
export const CONFIG_FILE = "config.json" as const;
export const MCP_CONFIG_FILE = "mcp.json" as const;
export const AGENTS_FILE = "agents.json" as const;
export const LLMS_FILE = "llms.json" as const;

/**
 * Default values
 */
export const DEFAULT_TIMEOUT_MS = 120000; // 2 minutes
export const DEFAULT_RELAYS = [
    "wss://relay.nostr.band",
    "wss://relay.damus.io",
    "wss://nos.lol"
] as const;

/**
 * Environment variables
 */
export const ENV_VARS = {
    NOSTR_PRIVATE_KEY: "NOSTR_PRIVATE_KEY",
    NOSTR_PUBLIC_KEY: "NOSTR_PUBLIC_KEY",
    OPENAI_API_KEY: "OPENAI_API_KEY",
    ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
} as const;