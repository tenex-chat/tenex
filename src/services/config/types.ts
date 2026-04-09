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
    version?: number; // TENEX state migration version (not app version)
    whitelistedPubkeys?: string[];
    whitelistedIdentities?: string[];
    tenexPrivateKey?: string; // Backend private key for publishing TENEX announcements
    backendName?: string; // Name for the TENEX backend profile (default: "tenex backend")
    projectsBase?: string; // Base directory for all projects (default: ~/tenex)
    relays?: string[]; // Nostr relay URLs
    identityRelays?: string[]; // Additional relays for publishing kind:0 identity events (default: wss://purplepag.es)
    blossomServerUrl?: string; // Blossom server URL for blob uploads (default: https://blossom.primal.net)

    // Logging configuration
    logging?: {
        logFile?: string; // Path to log file (default: ~/.tenex/daemon.log)
        level?: "silent" | "error" | "warn" | "info" | "debug"; // Log level (inherits from LOG_LEVEL env var if not set)
    };

    // Summarization configuration
    summarization?: {
        inactivityTimeoutSeconds?: number; // Seconds to wait after last activity before generating summary (default: 300 = 5 minutes)
    };

    // Context-management configuration
    contextManagement?: {
        enabled?: boolean; // Enable ai-sdk-context-management strategies (default: true)
        tokenBudget?: number; // Managed working-context token budget (default: 40000)
        forceScratchpadThresholdPercent?: number; // Managed-context utilization percent that forces scratchpad (default: 70)
        utilizationWarningThresholdPercent?: number; // Managed-context utilization percent for warnings (default: 70)
        compactionThresholdPercent?: number; // Managed-context utilization percent for automatic compaction (default: 90)
        toolResultDecay?: {
            minTotalSavingsTokens?: number; // Minimum token savings required before decaying (default: 20000)
            minDepth?: number; // Minimum message age (turns ago) before considering decay (default: 20)
            excludeToolNames?: string[]; // Tool names to never decay (default: ["delegate", "delegate_followup"])
        };
        strategies?: {
            reminders?: boolean; // Enable RemindersStrategy (default: true)
            scratchpad?: boolean; // Enable ScratchpadStrategy (default: true)
            toolResultDecay?: boolean; // Enable ToolResultDecayStrategy (default: true)
            compaction?: boolean; // Enable CompactionToolStrategy (default: true)
            contextUtilizationReminder?: boolean; // Enable RemindersStrategy context utilization source (default: true)
            contextWindowStatus?: boolean; // Enable RemindersStrategy context-window-status source (default: true)
        };
    };

    // Telemetry configuration
    telemetry?: {
        enabled?: boolean; // Enable OpenTelemetry tracing (default: true)
        serviceName?: string; // OTL trace service name (default: 'tenex-daemon')
        endpoint?: string; // OTLP HTTP endpoint URL (default: http://localhost:4318/v1/traces)
        analysis?: {
            enabled?: boolean; // Enable local analysis telemetry store (default: false)
            dbPath?: string; // SQLite DB path (default: ~/.tenex/data/trace-analysis.db)
            retentionDays?: number; // Retain rows for this many days (default: 14)
            largeMessageThresholdTokens?: number; // Threshold for carry tracking (default: 2000)
            storeMessagePreviews?: boolean; // Store short prompt previews (default: true)
            maxPreviewChars?: number; // Preview length cap (default: 256)
            storeFullMessageText?: boolean; // Store full prompt text in analysis DB (default: true)
        };
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

    // Intervention configuration
    // Monitors agent work completions and triggers human-replica review if user doesn't respond
    intervention?: {
        enabled?: boolean; // Enable intervention monitoring (default: false)
        agent?: string; // Agent slug to notify when user doesn't respond (required if enabled)
        timeoutSeconds?: number; // Seconds to wait for user response (default: 300 = 5 minutes)
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
    version: z.number().int().nonnegative().optional(),
    whitelistedPubkeys: z.array(z.string()).optional(),
    whitelistedIdentities: z.array(z.string()).optional(),
    tenexPrivateKey: z.string().optional(),
    backendName: z.string().optional(),
    projectsBase: z.string().optional(),
    relays: z.array(z.string()).optional(),
    identityRelays: z.array(z.string()).optional(),
    blossomServerUrl: z.string().optional(),
    logging: z
        .object({
            logFile: z.string().optional(),
            level: z.enum(["silent", "error", "warn", "info", "debug"]).optional(),
        })
        .optional(),
    summarization: z
        .object({
            inactivityTimeoutSeconds: z.number().optional(),
        })
        .optional(),
    contextManagement: z
        .object({
            enabled: z.boolean().optional(),
            tokenBudget: z.number().positive().optional(),
            forceScratchpadThresholdPercent: z.number().min(0).max(100).optional(),
            utilizationWarningThresholdPercent: z.number().min(0).max(100).optional(),
            compactionThresholdPercent: z.number().min(0).max(100).optional(),
            toolResultDecay: z
                .object({
                    minTotalSavingsTokens: z.number().int().nonnegative().optional(),
                    minDepth: z.number().int().nonnegative().optional(),
                    excludeToolNames: z.array(z.string()).optional(),
                })
                .optional(),
            strategies: z
                .object({
                    reminders: z.boolean().optional(),
                    scratchpad: z.boolean().optional(),
                    toolResultDecay: z.boolean().optional(),
                    compaction: z.boolean().optional(),
                    contextUtilizationReminder: z.boolean().optional(),
                    contextWindowStatus: z.boolean().optional(),
                })
                .optional(),
        })
        .optional(),
    telemetry: z
        .object({
            enabled: z.boolean().optional(),
            serviceName: z.string().optional(),
            endpoint: z.string().optional(),
            analysis: z
                .object({
                    enabled: z.boolean().optional(),
                    dbPath: z.string().optional(),
                    retentionDays: z.number().int().positive().optional(),
                    largeMessageThresholdTokens: z.number().int().positive().optional(),
                    storeMessagePreviews: z.boolean().optional(),
                    maxPreviewChars: z.number().int().positive().optional(),
                    storeFullMessageText: z.boolean().optional(),
                })
                .optional(),
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
    intervention: z
        .object({
            enabled: z.boolean().optional(),
            agent: z.string().optional(),
            timeoutSeconds: z.number().optional(),
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
    /** Codex reasoning effort */
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
    /** Codex reasoning summary detail */
    summary?: "auto" | "concise" | "detailed" | "none";
    /** Codex system personality */
    personality?: "none" | "friendly" | "pragmatic";
    /** Codex execution approval policy */
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
    /** Codex sandbox policy */
    sandboxPolicy?: "read-only" | "workspace-write" | "danger-full-access";
    /** Additional Codex instructions appended to the system prompt */
    developerInstructions?: string;
    /** Additional Codex base instructions */
    baseInstructions?: string;
    /** Additional Codex config overrides */
    configOverrides?: Record<string, unknown>;
    /** Enable RMCP client support for Codex */
    rmcpClient?: boolean;
    /** Close the shared Codex app-server after this many idle milliseconds */
    idleTimeoutMs?: number;
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
    promptCompilation?: string; // Named config to use for prompt compilation (compiling lessons into system prompts)
    categorization?: string; // Named config to use for agent role categorization
}

/**
 * Schema for meta model variant
 */
export const MetaModelVariantSchema = z.object({
    model: z.string(),
    keywords: z.array(z.string()).optional(),
    description: z.string().optional(),
    systemPrompt: z.string().optional(),
});

/**
 * Schema for meta model configuration
 */
export const MetaModelConfigurationSchema = z.object({
    provider: z.literal("meta"),
    variants: z.record(z.string(), MetaModelVariantSchema),
    default: z.string(),
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
        effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
        summary: z.enum(["auto", "concise", "detailed", "none"]).optional(),
        personality: z.enum(["none", "friendly", "pragmatic"]).optional(),
        approvalPolicy: z.enum(["untrusted", "on-failure", "on-request", "never"]).optional(),
        sandboxPolicy: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
        developerInstructions: z.string().optional(),
        baseInstructions: z.string().optional(),
        configOverrides: z.record(z.string(), z.unknown()).optional(),
        rmcpClient: z.boolean().optional(),
        idleTimeoutMs: z.number().int().positive().optional(),
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
    promptCompilation: z.string().optional(),
    categorization: z.string().optional(),
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

// resolveApiKey has moved to @/llm/providers/key-manager — re-export for backwards compatibility
export { resolveApiKey } from "@/llm/providers/key-manager";

export type ConfigFile = "config.json" | "llms.json" | "mcp.json" | "providers.json";

export interface ConfigPaths {
    global: string;
    project?: string;
}
