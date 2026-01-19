/**
 * Claude Code Provider
 *
 * Claude Code is a specialized agent-based provider that runs Claude
 * with built-in coding tools and MCP server support.
 */

import { type ClaudeCodeSettings, createClaudeCode } from "ai-sdk-provider-claude-code";
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
 * AI SDK usage with optional extended fields
 */
interface ExtendedUsage extends LanguageModelUsage {
    cachedInputTokens?: number;
    reasoningTokens?: number;
}

/**
 * Claude Code provider implementation
 */
export class ClaudeCodeProvider extends AgentProvider {
    private enableTenexTools = true;

    static readonly METADATA: ProviderMetadata = AgentProvider.createMetadata(
        "claude-code",
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
    ): ClaudeCodeSettings {
        // Extract tool names from the provided tools
        const toolNames = context.tools ? Object.keys(context.tools) : [];
        const regularTools = toolNames.filter((name) => !name.startsWith("mcp__"));

        trace.getActiveSpan()?.addEvent("llm_factory.creating_claude_code", {
            "agent.name": context.agentName ?? "",
            "session.id": context.sessionId ?? "",
            "tools.count": regularTools.length,
            "tenex_tools.enabled": this.enableTenexTools,
            "cwd.from_context": context.workingDirectory ?? "(undefined)",
        });

        // Create SDK MCP server for local TENEX tools if enabled
        const tenexSdkServer =
            this.enableTenexTools && regularTools.length > 0 && context.tools
                ? ClaudeCodeToolsAdapter.createSdkMcpServer(context.tools)
                : undefined;

        // Build mcpServers configuration
        // ClaudeCodeSettings.mcpServers accepts heterogeneous server types (stdio, SDK servers, etc.)
        // biome-ignore lint/suspicious/noExplicitAny: ClaudeCodeSettings.mcpServers accepts varied server types
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mcpServersConfig: Record<string, any> = {};

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
        const settings: ClaudeCodeSettings = {
            permissionMode: "bypassPermissions",
            verbose: true,
            cwd: context.workingDirectory,
            // Ensure Bash tool uses the project working directory, not the session's stored cwd
            env: {
                CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
            },
            mcpServers: mcpServersConfig,
            disallowedTools: ["AskUserQuestion"],
            persistSession: false,
            logger: {
                warn: (message: string) => logger.warn("[ClaudeCode]", message),
                error: (message: string) => logger.error("[ClaudeCode]", message),
                info: (message: string) => logger.info("[ClaudeCode]", message),
                debug: (message: string) => logger.debug("[ClaudeCode]", message),
            },
        };

        return settings;
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
