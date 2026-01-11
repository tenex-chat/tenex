/**
 * Claude Code Provider
 *
 * Claude Code is a specialized agent-based provider that runs Claude
 * with built-in coding tools and MCP server support.
 */

import { type ClaudeCodeSettings, createClaudeCode } from "ai-sdk-provider-claude-code";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type {
    ProviderInitConfig,
    ProviderMetadata,
    ProviderRuntimeContext,
} from "../types";
import { AgentProvider, type AgentProviderFunction } from "../base/AgentProvider";
import { TenexToolsAdapter } from "../TenexToolsAdapter";

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
            sessionResumption: true,
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

        console.log("[ClaudeCodeProvider] Tool analysis:", {
            agentName: context.agentName,
            totalToolNames: toolNames.length,
            regularTools: regularTools.length,
            toolNames,
            regularToolNames: regularTools,
            enableTenexTools: this.enableTenexTools,
            hasToolsContext: !!context.tools,
        });

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
                ? TenexToolsAdapter.createSdkMcpServer(context.tools, context)
                : undefined;

        // Build mcpServers configuration
        // ClaudeCodeSettings.mcpServers accepts heterogeneous server types (stdio, SDK servers, etc.)
        // biome-ignore lint/suspicious/noExplicitAny: ClaudeCodeSettings.mcpServers accepts varied server types
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mcpServersConfig: Record<string, any> = {};

        // Add TENEX tools wrapper if enabled
        if (tenexSdkServer) {
            mcpServersConfig.tenex = tenexSdkServer;
            console.log("[ClaudeCodeProvider] Added TENEX SDK MCP server to mcpServersConfig", {
                serverName: "tenex",
                toolCount: regularTools.length,
            });
        } else {
            console.log("[ClaudeCodeProvider] TENEX SDK MCP server NOT added", {
                reason: !this.enableTenexTools ? "enableTenexTools is false" :
                        regularTools.length === 0 ? "no regular tools" :
                        !context.tools ? "context.tools is undefined" :
                        "unknown",
                enableTenexTools: this.enableTenexTools,
                regularToolsCount: regularTools.length,
                hasToolsContext: !!context.tools,
            });
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

            console.log("[ClaudeCodeProvider] Added external MCP servers from context", {
                serverCount: Object.keys(mcpConfig.servers).length,
                serverNames: Object.keys(mcpConfig.servers),
            });
        }

        console.log("[ClaudeCodeProvider] Final mcpServersConfig:", {
            totalServers: Object.keys(mcpServersConfig).length,
            serverNames: Object.keys(mcpServersConfig),
            hasTenexServer: !!mcpServersConfig.tenex,
            hasExternalServers: Object.keys(mcpServersConfig).some(name => name !== "tenex"),
        });

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
            disallowedTools: [],
            logger: {
                warn: (message: string) => logger.warn("[ClaudeCode]", message),
                error: (message: string) => logger.error("[ClaudeCode]", message),
                info: (message: string) => logger.info("[ClaudeCode]", message),
                debug: (message: string) => logger.debug("[ClaudeCode]", message),
            },
        };

        // Handle session resumption
        if (context.sessionId) {
            settings.resume = context.sessionId;
        }

        return settings;
    }

    /**
     * Claude Code is always available (no API key required)
     */
    isAvailable(): boolean {
        return this._initialized;
    }
}
