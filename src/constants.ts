import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Global constants used throughout the TENEX codebase
 */

/**
 * Directory names
 */
export const TENEX_DIR = ".tenex" as const;

/**
 * Get the base TENEX directory path.
 * Respects TENEX_BASE_DIR environment variable for running multiple isolated instances.
 *
 * Default: ~/.tenex
 * Override: Set TENEX_BASE_DIR=/path/to/custom/dir
 *
 * @returns The absolute path to the TENEX base directory
 */
export function getTenexBasePath(): string {
    return process.env.TENEX_BASE_DIR || join(homedir(), TENEX_DIR);
}

/**
 * File names
 */
export const CONFIG_FILE = "config.json" as const;
export const MCP_CONFIG_FILE = "mcp.json" as const;
export const LLMS_FILE = "llms.json" as const;
export const PROVIDERS_FILE = "providers.json" as const;


