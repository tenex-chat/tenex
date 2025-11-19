/**
 * Global constants used throughout the TENEX codebase
 */

/**
 * Directory names
 */
export const TENEX_DIR = ".tenex" as const;

/**
 * File names
 */
export const CONFIG_FILE = "config.json" as const;
export const MCP_CONFIG_FILE = "mcp.json" as const;
export const LLMS_FILE = "llms.json" as const;

/**
 * Default Nostr relay URLs for TENEX
 */
export const DEFAULT_RELAY_URLS = ["wss://tenex.chat"];
