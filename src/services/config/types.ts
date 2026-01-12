import { z } from "zod";

/**
 * Unified configuration types for TENEX
 * All configuration files use the same schemas for both global and project contexts
 */

// =====================================================================================
// MAIN CONFIG SCHEMA (config.json)
// =====================================================================================

export interface TenexConfig {
    // Global fields
    whitelistedPubkeys?: string[];
    tenexPrivateKey?: string; // Backend private key for publishing TENEX announcements
    projectsBase?: string; // Base directory for all projects (default: ~/tenex)
    relays?: string[]; // Nostr relay URLs
    blossomServerUrl?: string; // Blossom server URL for blob uploads (default: https://blossom.primal.net)

    // Claude Code specific configuration
    claudeCode?: {
        enableTenexTools?: boolean; // Feature flag: provide TENEX tools to claude-code agents (default: true)
    };

    // Logging configuration
    logging?: {
        logFile?: string; // Path to log file (default: ~/.tenex/daemon.log)
        level?: "silent" | "error" | "warn" | "info" | "debug"; // Log level (inherits from LOG_LEVEL env var if not set)
    };

    // Summarization configuration
    summarization?: {
        inactivityTimeout?: number; // Milliseconds to wait after last activity before generating summary (default: 300000 = 5 minutes)
    };

    // Project fields (optional for global config)
    description?: string;
    repoUrl?: string;
    projectNaddr?: string;
}

export const TenexConfigSchema = z.object({
    whitelistedPubkeys: z.array(z.string()).optional(),
    tenexPrivateKey: z.string().optional(),
    projectsBase: z.string().optional(),
    relays: z.array(z.string()).optional(),
    blossomServerUrl: z.string().optional(),
    claudeCode: z
        .object({
            enableTenexTools: z.boolean().optional(),
        })
        .optional(),
    logging: z
        .object({
            logFile: z.string().optional(),
            level: z.enum(["silent", "error", "warn", "info", "debug"]).optional(),
        })
        .optional(),
    summarization: z
        .object({
            inactivityTimeout: z.number().optional(),
        })
        .optional(),
    description: z.string().optional(),
    repoUrl: z.string().optional(),
    projectNaddr: z.string().optional(),
});

// =====================================================================================
// LLM SCHEMA (llms.json)
// =====================================================================================

/**
 * Individual LLM configuration
 */
export interface LLMConfiguration {
    provider: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    /** Reasoning effort level (for codex-app-server provider) */
    reasoningEffort?: "none" | "low" | "medium" | "high";
    [key: string]: unknown; // Allow additional provider-specific settings
}

/**
 * Main LLM configuration structure
 */
export interface TenexLLMs {
    providers: Record<
        string,
        {
            apiKey: string;
        }
    >;
    configurations: Record<string, LLMConfiguration>;
    default?: string;
    summarization?: string; // Named config to use for generating summaries (kind 513 events)
    supervision?: string; // Named config to use for agent supervision
}

export const LLMConfigurationSchema = z
    .object({
        provider: z.string(),
        model: z.string(),
        temperature: z.number().optional(),
        maxTokens: z.number().optional(),
        topP: z.number().optional(),
        reasoningEffort: z.enum(["none", "low", "medium", "high"]).optional(),
    })
    .passthrough(); // Allow additional properties

export const TenexLLMsSchema = z.object({
    providers: z
        .record(
            z.string(),
            z.object({
                apiKey: z.string(),
            })
        )
        .default({}),
    configurations: z.record(z.string(), LLMConfigurationSchema).default({}),
    default: z.string().optional(),
    summarization: z.string().optional(),
    supervision: z.string().optional(),
});

// =====================================================================================
// MCP SCHEMA (mcp.json)
// =====================================================================================

export interface MCPServerConfig {
    command: string;
    args: string[];
    env?: Record<string, string>;
    description?: string;
    allowedPaths?: string[];
    eventId?: string; // Nostr event ID this server was installed from
}

export interface TenexMCP {
    servers: Record<string, MCPServerConfig>;
    enabled: boolean;
}

export const MCPServerConfigSchema = z.object({
    command: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()).optional(),
    description: z.string().optional(),
    allowedPaths: z.array(z.string()).optional(),
    eventId: z.string().optional(),
});

export const TenexMCPSchema = z.object({
    servers: z.record(z.string(), MCPServerConfigSchema).default({}),
    enabled: z.boolean().default(true),
});

// =====================================================================================
// LOADED CONFIGURATION STATE
// =====================================================================================

export interface LoadedConfig {
    config: TenexConfig;
    llms: TenexLLMs;
    mcp: TenexMCP;
}

// =====================================================================================
// HELPER TYPES
// =====================================================================================

export type ConfigFile = "config.json" | "llms.json" | "mcp.json";

export interface ConfigPaths {
    global: string;
    project?: string;
}
