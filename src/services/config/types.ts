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
    backendName?: string; // Name for the TENEX backend profile (default: "tenex backend")
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

    // Telemetry configuration
    telemetry?: {
        enabled?: boolean; // Enable OpenTelemetry tracing (default: true)
        serviceName?: string; // OTL trace service name (default: 'tenex-daemon')
        endpoint?: string; // OTLP HTTP endpoint URL (default: http://localhost:4318/v1/traces)
    };

    // Global system prompt configuration
    // When set, this content is added to ALL projects' system prompts
    globalSystemPrompt?: {
        enabled?: boolean; // Enable the global system prompt (default: true when content exists)
        content?: string; // The actual system prompt content
    };

    // Escalation agent configuration
    // When set, ask() tool calls are routed through this agent instead of directly to the user
    escalation?: {
        agent?: string; // Agent slug to route ask() calls through (acts as first line of defense)
    };

    // Compression configuration
    // Controls conversation history compression to manage context window
    compression?: {
        enabled?: boolean; // Enable compression (default: true)
        tokenThreshold?: number; // Token count that triggers compression (default: 50000)
        tokenBudget?: number; // Target token count after compression (default: 40000)
        slidingWindowSize?: number; // Number of recent messages to keep in fallback mode (default: 50)
    };

    // Intervention configuration
    // Monitors agent work completions and triggers human-replica review if user doesn't respond
    intervention?: {
        enabled?: boolean; // Enable intervention monitoring (default: false)
        agent?: string; // Agent slug to notify when user doesn't respond (required if enabled)
        timeout?: number; // Milliseconds to wait for user response (default: 300000 = 5 minutes)
        conversationInactivityTimeoutSeconds?: number; // Seconds since last user message to skip intervention (default: 120 = 2 minutes). If user was active within this window when agent tags them, skip intervention entirely.
    };

    // APNs push notification configuration
    apns?: {
        enabled?: boolean;                // Master switch (default: false)
        keyPath?: string;                 // Path to .p8 key file from Apple
        keyId?: string;                   // Apple Key ID (from developer portal)
        teamId?: string;                  // Apple Team ID
        bundleId?: string;                // App Bundle ID (e.g., com.example.tenex)
        production?: boolean;             // true = api.push.apple.com, false = api.sandbox.push.apple.com
    };

    // NIP-46 remote signing configuration
    nip46?: {
        enabled?: boolean;                    // Master switch (default: false)
        signingTimeoutMs?: number;            // Per-request timeout (default: 30000)
        maxRetries?: number;                  // Per-request retries (default: 2)
        owners?: Record<string, {             // Per-owner config, keyed by hex pubkey
            bunkerUri?: string;               // bunker://pubkey?relay=wss://...
        }>;
    };

    // Project fields (optional for global config)
    description?: string;
    repoUrl?: string;
    projectNaddr?: string;
}

export const TenexConfigSchema = z.object({
    whitelistedPubkeys: z.array(z.string()).optional(),
    tenexPrivateKey: z.string().optional(),
    backendName: z.string().optional(),
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
    telemetry: z
        .object({
            enabled: z.boolean().optional(),
            serviceName: z.string().optional(),
            endpoint: z.string().optional(),
        })
        .optional(),
    globalSystemPrompt: z
        .object({
            enabled: z.boolean().optional(),
            content: z.string().optional(),
        })
        .optional(),
    escalation: z
        .object({
            agent: z.string().optional(),
        })
        .optional(),
    compression: z
        .object({
            enabled: z.boolean().optional(),
            tokenThreshold: z.number().optional(),
            tokenBudget: z.number().optional(),
            slidingWindowSize: z.number().optional(),
        })
        .optional(),
    intervention: z
        .object({
            enabled: z.boolean().optional(),
            agent: z.string().optional(),
            timeout: z.number().optional(),
            conversationInactivityTimeoutSeconds: z.number().optional(),
        })
        .optional(),
    apns: z
        .object({
            enabled: z.boolean().optional(),
            keyPath: z.string().optional(),
            keyId: z.string().optional(),
            teamId: z.string().optional(),
            bundleId: z.string().optional(),
            production: z.boolean().optional(),
        })
        .optional(),
    nip46: z
        .object({
            enabled: z.boolean().optional(),
            signingTimeoutMs: z.number().optional(),
            maxRetries: z.number().optional(),
            owners: z
                .record(
                    z.string(),
                    z.object({
                        bunkerUri: z.string().optional(),
                    })
                )
                .optional(),
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
 * Meta model variant configuration
 * Defines a variant within a meta model that maps to a specific underlying model
 */
export interface MetaModelVariant {
    /** The underlying LLM configuration name to use for this variant */
    model: string;
    /** Keywords that trigger this variant (e.g., ["think", "ponder"]) */
    keywords?: string[];
    /** Description of when to use this variant - shown in system prompt */
    description?: string;
    /** Optional additional system prompt to inject when this variant is active */
    systemPrompt?: string;
    /** Priority tier for conflict resolution (higher number = higher priority) */
    tier?: number;
}

/**
 * Meta model configuration
 * A meta model is a virtual model that dynamically selects from underlying models
 */
export interface MetaModelConfiguration {
    /** Must be "meta" to identify this as a meta model */
    provider: "meta";
    /** Map of variant names to their configurations */
    variants: Record<string, MetaModelVariant>;
    /** Default variant to use when no keyword matches */
    default: string;
    /** Optional description shown in system prompt preamble */
    description?: string;
}

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
    reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
    [key: string]: unknown; // Allow additional provider-specific settings
}

/**
 * Type guard to check if a configuration is a meta model
 */
export function isMetaModelConfiguration(config: LLMConfiguration | MetaModelConfiguration): config is MetaModelConfiguration {
    return config.provider === "meta" && "variants" in config;
}

/**
 * Any LLM configuration type (standard or meta model)
 */
export type AnyLLMConfiguration = LLMConfiguration | MetaModelConfiguration;

/**
 * Main LLM configuration structure
 */
export interface TenexLLMs {
    configurations: Record<string, AnyLLMConfiguration>;
    default?: string;
    summarization?: string; // Named config to use for generating summaries (kind 513 events)
    supervision?: string; // Named config to use for agent supervision
    search?: string; // Named config to use for search operations
    promptCompilation?: string; // Named config to use for prompt compilation (compiling lessons into system prompts)
    compression?: string; // Named config to use for conversation history compression
}

/**
 * Schema for meta model variant
 */
export const MetaModelVariantSchema = z.object({
    model: z.string(),
    keywords: z.array(z.string()).optional(),
    description: z.string().optional(),
    systemPrompt: z.string().optional(),
    tier: z.number().optional(),
});

/**
 * Schema for meta model configuration
 */
export const MetaModelConfigurationSchema = z.object({
    provider: z.literal("meta"),
    variants: z.record(z.string(), MetaModelVariantSchema),
    default: z.string(),
    description: z.string().optional(),
});

/**
 * Schema for standard LLM configuration
 */
export const StandardLLMConfigurationSchema = z
    .object({
        provider: z.string(),
        model: z.string(),
        temperature: z.number().optional(),
        maxTokens: z.number().optional(),
        topP: z.number().optional(),
        reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
    })
    .passthrough(); // Allow additional properties

/**
 * Union schema that accepts either standard or meta model configurations
 */
export const LLMConfigurationSchema = z.union([
    MetaModelConfigurationSchema,
    StandardLLMConfigurationSchema,
]);

export const TenexLLMsSchema = z.object({
    configurations: z.record(z.string(), LLMConfigurationSchema).default({}),
    default: z.string().optional(),
    summarization: z.string().optional(),
    supervision: z.string().optional(),
    search: z.string().optional(),
    promptCompilation: z.string().optional(),
    compression: z.string().optional(),
});

// =====================================================================================
// PROVIDER CREDENTIALS SCHEMA (providers.json)
// =====================================================================================

/**
 * Provider credentials configuration
 * Contains API keys and connection details for external providers
 */
export interface ProviderCredentials {
    apiKey: string | string[];
    baseUrl?: string;
    timeout?: number;
    options?: Record<string, unknown>;
}

/**
 * Main provider credentials structure
 */
export interface TenexProviders {
    providers: Record<string, ProviderCredentials>;
}

export const ProviderCredentialsSchema = z.object({
    apiKey: z.union([z.string(), z.array(z.string())]),
    baseUrl: z.string().optional(),
    timeout: z.number().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
});

export const TenexProvidersSchema = z.object({
    providers: z.record(z.string(), ProviderCredentialsSchema).default({}),
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
    providers: TenexProviders;
}

// =====================================================================================
// HELPER TYPES
// =====================================================================================

/**
 * Resolve an API key that may be a single string or an array.
 * For services that only need a single key (embeddings, image gen),
 * this returns the first key from an array or the string itself.
 */
export function resolveApiKey(apiKey: string | string[] | undefined): string | undefined {
    if (!apiKey) return undefined;
    if (Array.isArray(apiKey)) return apiKey[0];
    return apiKey;
}

export type ConfigFile = "config.json" | "llms.json" | "mcp.json" | "providers.json";

export interface ConfigPaths {
    global: string;
    project?: string;
}
