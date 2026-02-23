/**
 * Claude Code Provider
 *
 * Claude Code is a specialized agent-based provider that runs Claude
 * with built-in coding tools and MCP server support.
 */

import { type ClaudeCodeSettings, type McpServerConfig, createClaudeCode } from "ai-sdk-provider-claude-code";
import type { LanguageModelUsage } from "ai";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type { LanguageModelUsageWithCostUsd } from "../../types";
import type {
    ProviderInitConfig,
    ProviderMetadata,
    ProviderRuntimeContext,
} from "../types";
import { AgentProvider, type AgentProviderFunction } from "../base/AgentProvider";
import { ClaudeCodeToolsAdapter } from "./ClaudeCodeToolsAdapter";
import { PROVIDER_IDS } from "../provider-ids";

/**
 * Claude Code-specific metadata structure
 */
interface ClaudeCodeProviderMetadata {
    costUsd?: number;
    sessionId?: string;
    durationMs?: number;
}

/**
 * Mapping between Claude Code built-in tools and their TENEX/MCP equivalents.
 * Used to determine which built-in tools to disable when TENEX provides alternatives.
 */
interface ToolMapping {
    tenex?: string;
    mcpPatterns?: RegExp[];
}

/** Claude Code built-in tools and their TENEX/MCP equivalents.
 * Note: Read is deliberately absent. Claude Code saves large MCP tool results
 * to files and expects the model to use its built-in Read to access them.
 * Disabling Read leaves agents unable to retrieve any large tool result. */
const TOOL_MAPPINGS: Readonly<Record<string, ToolMapping>> = {
    // File system tools (Read excluded — see comment above)
    Write: { tenex: "fs_write", mcpPatterns: [/^mcp__.*__fs_write$/, /^mcp__.*__write_file$/] },
    Edit: { tenex: "fs_edit", mcpPatterns: [/^mcp__.*__fs_edit$/, /^mcp__.*__edit_file$/] },
    Glob: { tenex: "fs_glob", mcpPatterns: [/^mcp__.*__fs_glob$/, /^mcp__.*__glob$/] },
    Grep: { tenex: "fs_grep", mcpPatterns: [/^mcp__.*__fs_grep$/, /^mcp__.*__grep$/] },
    LS: { tenex: "fs_glob", mcpPatterns: [/^mcp__.*__fs_glob$/, /^mcp__.*__list_directory$/] },
    // Web tools
    WebFetch: { tenex: "web_fetch", mcpPatterns: [/^mcp__.*__web_fetch$/, /^mcp__.*__fetch$/] },
    WebSearch: { tenex: "web_search", mcpPatterns: [/^mcp__.*__web_search$/, /^mcp__.*__search$/] },
    // Shell tools (Bash is controlled via TENEX's shell tool)
    Bash: { tenex: "shell", mcpPatterns: [/^mcp__.*__shell$/, /^mcp__.*__bash$/, /^mcp__.*__execute$/] },
    // Notebook tools
    NotebookEdit: { tenex: undefined, mcpPatterns: [/^mcp__.*__notebook_edit$/] },
    // Task/agent tools (TENEX uses delegate)
    Task: { tenex: "delegate", mcpPatterns: [/^mcp__.*__delegate$/] },
    // Todo tools (TENEX uses its own conversation-scoped todo_write)
    TodoWrite: { tenex: "todo_write", mcpPatterns: [/^mcp__.*__todo_write$/, /^mcp__.*__write_todos$/] },
} as const;

/** File system tool names that indicate FS capability */
const FS_TOOL_NAMES = ["fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep"] as const;

/** Built-in tools that TENEX always controls — agents get these only via TENEX's equivalents.
 * Read is excluded: Claude Code saves large MCP tool results to files and needs
 * its built-in Read to let the model access them. */
const ALWAYS_DISABLED_BUILTINS = ["Write", "Edit", "Glob", "Grep", "LS", "NotebookEdit", "Bash", "TaskOutput"] as const;

/** Pattern to detect MCP tools that provide FS capability */
const MCP_FS_CAPABILITY_PATTERN = /mcp__.*__(fs_read|fs_write|fs_edit|fs_glob|fs_grep|read_file|write_file|edit_file|list_directory)/;

/**
 * AI SDK usage with optional extended fields
 */
interface ExtendedUsage extends LanguageModelUsage {
    cachedInputTokens?: number;
    reasoningTokens?: number;
}

type ClaudeCodeSettingsWithStreamStart = ClaudeCodeSettings & {
    onStreamStart?: ProviderRuntimeContext["onStreamStart"];
};

/**
 * Claude Code provider implementation
 */
export class ClaudeCodeProvider extends AgentProvider {
    private enableTenexTools = true;

    static readonly METADATA: ProviderMetadata = AgentProvider.createMetadata(
        PROVIDER_IDS.CLAUDE_CODE,
        "Claude Code",
        "Claude with built-in coding tools and MCP support",
        "agent",
        "claude-sonnet-4-20250514",
        {
            streaming: true,
            toolCalling: true,
            builtInTools: true,
            sessionResumption: false,
            requiresApiKey: false,
            mcpSupport: true,
        },
        "https://docs.anthropic.com/en/docs/claude-code"
    );

    get metadata(): ProviderMetadata {
        return ClaudeCodeProvider.METADATA;
    }

    /**
     * Initialize with TENEX tools setting
     */
    async initialize(config: ProviderInitConfig): Promise<void> {
        this.enableTenexTools = config.options?.enableTenexTools !== false;
        await super.initialize(config);
    }

    /**
     * Create the Claude Code provider function
     */
    protected createProviderFunction(_config: ProviderInitConfig): AgentProviderFunction {
        // Return a function that creates providers with the right settings
        // The actual settings are applied in createAgentSettings
        return createClaudeCode({
            defaultSettings: {},
        }) as AgentProviderFunction;
    }

    /**
     * Create the agent settings for Claude Code
     */
    protected createAgentSettings(
        context: ProviderRuntimeContext,
        _modelId: string
    ): ClaudeCodeSettingsWithStreamStart {
        // Extract tool names from the provided tools
        const toolNames = context.tools ? Object.keys(context.tools) : [];
        const regularTools = toolNames.filter((name) => !name.startsWith("mcp__"));
        const mcpTools = toolNames.filter((name) => name.startsWith("mcp__"));

        // Determine which built-in tools to disable based on TENEX configuration
        const disallowedTools = this.computeDisallowedBuiltinTools(regularTools, mcpTools);

        trace.getActiveSpan()?.addEvent("llm_factory.creating_claude_code", {
            "agent.name": context.agentName ?? "",
            "session.id": context.sessionId ?? "",
            "tools.count": regularTools.length,
            "mcp_tools.count": mcpTools.length,
            "tenex_tools.enabled": this.enableTenexTools,
            "cwd.from_context": context.workingDirectory ?? "(undefined)",
            "disallowed_builtins": disallowedTools.join(", "),
        });

        // Create SDK MCP server for local TENEX tools if enabled
        const tenexSdkServer =
            this.enableTenexTools && regularTools.length > 0 && context.tools
                ? ClaudeCodeToolsAdapter.createSdkMcpServer(context.tools)
                : undefined;

        // Build mcpServers configuration
        const mcpServersConfig: Record<string, McpServerConfig> = {};

        // Add TENEX tools wrapper if enabled
        if (tenexSdkServer) {
            mcpServersConfig.tenex = tenexSdkServer;
        }

        // Add MCP servers from context (passed from services layer)
        const mcpConfig = context.mcpConfig;
        if (mcpConfig?.enabled && mcpConfig.servers) {
            for (const [serverName, serverConfig] of Object.entries(mcpConfig.servers)) {
                mcpServersConfig[serverName] = {
                    type: "stdio" as const,
                    command: serverConfig.command,
                    args: serverConfig.args,
                    env: serverConfig.env,
                };
            }

            trace.getActiveSpan()?.addEvent("llm_factory.mcp_servers_added", {
                "mcp.server_count": Object.keys(mcpConfig.servers).length,
                "mcp.servers": Object.keys(mcpConfig.servers).join(", "),
            });
        }

        // Build the settings
        const settings: ClaudeCodeSettingsWithStreamStart = {
            permissionMode: "bypassPermissions",
            verbose: true,
            cwd: context.workingDirectory,
            // Ensure Bash tool uses the project working directory, not the session's stored cwd
            env: {
                CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
            },
            mcpServers: mcpServersConfig,
            disallowedTools,
            persistSession: false,
            // Enable streaming input for mid-execution message injection
            streamingInput: "always",
            logger: {
                warn: (message: string) => logger.warn("[ClaudeCode]", message),
                error: (message: string) => logger.error("[ClaudeCode]", message),
                info: (message: string) => logger.info("[ClaudeCode]", message),
                debug: (message: string) => logger.debug("[ClaudeCode]", message),
            },
        };

        // Pass through onStreamStart callback if provided (requires fork of ai-sdk-provider-claude-code)
        // The callback receives a MessageInjector when the stream starts, allowing mid-execution message injection
        if (context.onStreamStart) {
            settings.onStreamStart = context.onStreamStart;
        }

        return settings;
    }

    /**
     * Compute which Claude Code built-in tools should be disabled.
     *
     * FS and shell built-in tools (Read, Write, Edit, Glob, Grep, LS,
     * NotebookEdit, Bash) are ALWAYS disabled. TENEX controls filesystem
     * and shell access exclusively through its fs_* and shell tools,
     * provided conditionally based on agent configuration.
     *
     * Other built-in tools (WebFetch, etc.) are disabled when TENEX
     * provides an equivalent.
     */
    private computeDisallowedBuiltinTools(regularTools: string[], mcpTools: string[]): string[] {
        const { disallowed, hasAnyFsCapability } = this.computeDisallowedToolsCore(regularTools, mcpTools);

        // Log the decision for debugging (separate from pure computation)
        this.logDisallowedToolsDecision(disallowed, regularTools, hasAnyFsCapability);

        return disallowed;
    }

    /**
     * Pure computation of disallowed tools without side effects.
     */
    private computeDisallowedToolsCore(
        regularTools: string[],
        mcpTools: string[]
    ): { disallowed: string[]; hasAnyFsCapability: boolean } {
        // Always disallow AskUserQuestion - TENEX has its own ask tool
        // Always disallow FS built-in tools — TENEX controls filesystem access
        // exclusively through its fs_* tools. Agents get fs_* only when their
        // tool configuration includes them.
        const disallowed: string[] = ["AskUserQuestion", ...ALWAYS_DISABLED_BUILTINS];

        const hasTenexFsTools = FS_TOOL_NAMES.some(tool => regularTools.includes(tool));
        const hasMcpFsTools = mcpTools.some(tool => MCP_FS_CAPABILITY_PATTERN.test(tool));
        const hasAnyFsCapability = hasTenexFsTools || hasMcpFsTools;

        // Check each non-FS built-in tool and disable if TENEX/MCP provides equivalent
        for (const [builtinTool, mapping] of Object.entries(TOOL_MAPPINGS)) {
            if (disallowed.includes(builtinTool)) {
                continue;
            }

            const hasEquivalent = this.hasToolEquivalent(mapping, regularTools, mcpTools);

            if (hasEquivalent) {
                disallowed.push(builtinTool);
            }
        }

        return { disallowed, hasAnyFsCapability };
    }

    /**
     * Check if TENEX or MCP provides an equivalent for a built-in tool.
     */
    private hasToolEquivalent(
        mapping: ToolMapping,
        regularTools: string[],
        mcpTools: string[]
    ): boolean {
        // Check for TENEX tool equivalent
        if (mapping.tenex && regularTools.includes(mapping.tenex)) {
            return true;
        }

        // Check for MCP tool equivalent
        if (mapping.mcpPatterns) {
            for (const pattern of mapping.mcpPatterns) {
                if (mcpTools.some(tool => pattern.test(tool))) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Log the disallowed tools decision for debugging.
     */
    private logDisallowedToolsDecision(
        disallowed: string[],
        regularTools: string[],
        hasAnyFsCapability: boolean
    ): void {
        const relevantTools = [...FS_TOOL_NAMES, "shell", "web_fetch", "web_search", "delegate", "todo_write"] as const;
        logger.info("[ClaudeCodeProvider] Disabling built-in tools", {
            disallowed,
            tenexTools: regularTools.filter(t =>
                (relevantTools as readonly string[]).includes(t)
            ),
            hasFsCapability: hasAnyFsCapability,
            hasShell: regularTools.includes("shell"),
        });
    }

    /**
     * Claude Code is always available (no API key required)
     */
    isAvailable(): boolean {
        return this._initialized;
    }

    /**
     * Extract usage metadata from Claude Code provider response
     */
    static extractUsageMetadata(
        model: string,
        totalUsage: LanguageModelUsage | undefined,
        providerMetadata: Record<string, unknown> | undefined
    ): LanguageModelUsageWithCostUsd {
        const metadata = providerMetadata?.[PROVIDER_IDS.CLAUDE_CODE] as ClaudeCodeProviderMetadata | undefined;
        const extendedUsage = totalUsage as ExtendedUsage | undefined;

        const inputTokens = totalUsage?.inputTokens;
        const outputTokens = totalUsage?.outputTokens;
        const totalTokens = totalUsage?.totalTokens ??
            (inputTokens !== undefined && outputTokens !== undefined
                ? inputTokens + outputTokens
                : undefined);

        return {
            model,
            inputTokens,
            outputTokens,
            totalTokens,
            costUsd: metadata?.costUsd,
            cachedInputTokens: extendedUsage?.cachedInputTokens,
            reasoningTokens: extendedUsage?.reasoningTokens,
        } as LanguageModelUsageWithCostUsd;
    }
}
