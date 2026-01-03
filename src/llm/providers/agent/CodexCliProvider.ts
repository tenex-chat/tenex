/**
 * Codex CLI Provider
 *
 * Codex CLI is OpenAI's agent-based provider that runs with
 * built-in coding tools and MCP server support.
 */

import { type CodexCliSettings, createCodexCli } from "ai-sdk-provider-codex-cli";
import { config as configService } from "@/services/ConfigService";
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
 * Codex CLI provider implementation
 */
export class CodexCliProvider extends AgentProvider {
    private enableTenexTools = true;

    private static readonly _metadata: ProviderMetadata = AgentProvider.createMetadata(
        "codexCli",
        "Codex CLI",
        "OpenAI Codex with built-in coding tools and MCP support",
        "agent",
        "gpt-5.1-codex",
        {
            streaming: true,
            toolCalling: true,
            builtInTools: true,
            sessionResumption: true,
            requiresApiKey: false, // Uses local CLI
            mcpSupport: true,
        },
        "https://openai.com/codex"
    );

    get metadata(): ProviderMetadata {
        return CodexCliProvider._metadata;
    }

    /**
     * Initialize with TENEX tools setting
     */
    async initialize(config: ProviderInitConfig): Promise<void> {
        this.enableTenexTools = config.options?.enableTenexTools !== false;
        await super.initialize(config);
    }

    /**
     * Create the Codex CLI provider function
     */
    protected createProviderFunction(_config: ProviderInitConfig): AgentProviderFunction {
        return createCodexCli({
            defaultSettings: {},
        }) as AgentProviderFunction;
    }

    /**
     * Create the agent settings for Codex CLI
     */
    protected createAgentSettings(
        context: ProviderRuntimeContext,
        _modelId: string
    ): CodexCliSettings {
        // Extract tool names from the provided tools
        const toolNames = context.tools ? Object.keys(context.tools) : [];
        const regularTools = toolNames.filter((name) => !name.startsWith("mcp__"));

        trace.getActiveSpan()?.addEvent("llm_factory.creating_codex_cli", {
            "agent.name": context.agentName ?? "",
            "session.id": context.sessionId ?? "",
            "tools.count": regularTools.length,
            "tenex_tools.enabled": this.enableTenexTools,
        });

        // Create SDK MCP server for local TENEX tools if enabled
        const tenexSdkServer =
            this.enableTenexTools && regularTools.length > 0 && context.tools
                ? TenexToolsAdapter.createSdkMcpServer(context.tools, context)
                : undefined;

        // Build mcpServers configuration
        // biome-ignore lint/suspicious/noExplicitAny: MCP server config types vary between providers
        const mcpServersConfig: Record<string, any> = {};

        // Add TENEX tools wrapper if enabled
        if (tenexSdkServer) {
            mcpServersConfig.tenex = tenexSdkServer;
        }

        // Add TENEX's MCP servers from config
        const mcpConfig = configService.getMCP();
        if (mcpConfig.enabled && mcpConfig.servers) {
            for (const [serverName, serverConfig] of Object.entries(mcpConfig.servers)) {
                // Codex CLI uses 'transport' instead of 'type'
                mcpServersConfig[serverName] = {
                    transport: "stdio" as const,
                    command: serverConfig.command,
                    args: serverConfig.args,
                    env: serverConfig.env,
                };
            }

            trace.getActiveSpan()?.addEvent("llm_factory.codex_mcp_servers_added", {
                "mcp.server_count": Object.keys(mcpConfig.servers).length,
                "mcp.servers": Object.keys(mcpConfig.servers).join(", "),
            });
        }

        // Build the settings
        const settings: CodexCliSettings = {
            allowNpx: true,
            skipGitRepoCheck: true,
            cwd: context.workingDirectory,
            mcpServers: mcpServersConfig,
            approvalMode: "on-failure",
            sandboxMode: "workspace-write",
            verbose: true,
            logger: {
                warn: (message: string) => logger.warn("[CodexCli]", message),
                error: (message: string) => logger.error("[CodexCli]", message),
                info: (message: string) => logger.info("[CodexCli]", message),
                debug: (message: string) => logger.debug("[CodexCli]", message),
            },
        };

        // Handle session resumption
        // Note: Codex CLI may not support session resumption yet
        // The 'resume' property is optional and may need to be added
        // to the CodexCliSettings type in the future
        if (context.sessionId) {
            // biome-ignore lint/suspicious/noExplicitAny: resume may not be in type definition yet
            (settings as any).resume = context.sessionId;
        }

        return settings;
    }

    /**
     * Codex CLI is always available (no API key required)
     */
    isAvailable(): boolean {
        return this._initialized;
    }
}
