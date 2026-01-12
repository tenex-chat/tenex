/**
 * Codex App Server Provider
 *
 * OpenAI Codex using app-server mode with JSON-RPC for mid-execution
 * message injection support.
 */

import {
    createCodexAppServer,
    type CodexAppServerSettings,
    type Session,
    type McpServerConfigOrSdk,
} from "ai-sdk-provider-codex-app-server";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type {
    ProviderInitConfig,
    ProviderMetadata,
    ProviderRuntimeContext,
} from "../types";
import { AgentProvider, type AgentProviderFunction } from "../base/AgentProvider";
import { CodexAppServerToolsAdapter } from "./CodexAppServerToolsAdapter";

/**
 * Codex App Server provider implementation
 *
 * Unlike CodexCliProvider which uses one-shot execution, this provider
 * uses app-server mode for persistent threads and mid-execution injection.
 */
export class CodexAppServerProvider extends AgentProvider {
    static readonly METADATA: ProviderMetadata = AgentProvider.createMetadata(
        "codex-app-server",
        "Codex App Server",
        "OpenAI Codex with app-server mode and mid-execution injection",
        "agent",
        "gpt-5.1-codex-max",
        {
            streaming: true,
            toolCalling: true,
            builtInTools: true,
            sessionResumption: true,
            requiresApiKey: false,
            mcpSupport: true,
        },
        "https://openai.com/codex"
    );

    private currentSession: Session | null = null;

    get metadata(): ProviderMetadata {
        return CodexAppServerProvider.METADATA;
    }

    /**
     * Get the current session for mid-execution injection
     */
    getSession(): Session | null {
        return this.currentSession;
    }

    /**
     * Create the Codex App Server provider function
     */
    protected createProviderFunction(_config: ProviderInitConfig): AgentProviderFunction {
        return createCodexAppServer({
            defaultSettings: {},
        }) as AgentProviderFunction;
    }

    /**
     * Create the agent settings for Codex App Server
     */
    protected createAgentSettings(
        context: ProviderRuntimeContext,
        _modelId: string
    ): CodexAppServerSettings {
        trace.getActiveSpan()?.addEvent("llm_factory.creating_codex_app_server", {
            "agent.name": context.agentName ?? "",
            "session.id": context.sessionId ?? "",
        });

        const toolNames = context.tools ? Object.keys(context.tools) : [];
        const regularTools = toolNames.filter((name) => !name.startsWith("mcp__"));

        logger.debug("[CodexAppServerProvider] Tool analysis", {
            agentName: context.agentName,
            totalToolNames: toolNames.length,
            regularTools: regularTools.length,
        });

        // Build mcpServers configuration - can include SdkMcpServer for in-process tools
        const mcpServersConfig: Record<string, McpServerConfigOrSdk> = {};

        // Create TENEX SDK MCP server if we have TENEX tools
        if (context.tools && regularTools.length > 0) {
            const tenexServer = CodexAppServerToolsAdapter.createSdkMcpServer(
                context.tools,
                { agentName: context.agentName }
            );
            if (tenexServer) {
                mcpServersConfig.tenex = tenexServer;
                logger.debug("[CodexAppServerProvider] Added TENEX SDK MCP server", {
                    toolCount: regularTools.length,
                });
            }
        }

        // Add configured MCP servers (stdio format)
        const mcpConfig = context.mcpConfig;
        if (mcpConfig?.enabled && mcpConfig.servers) {
            for (const [serverName, serverConfig] of Object.entries(mcpConfig.servers)) {
                mcpServersConfig[serverName] = {
                    transport: "stdio",
                    command: serverConfig.command,
                    args: serverConfig.args,
                    env: serverConfig.env,
                };
            }

            trace.getActiveSpan()?.addEvent("llm_factory.codex_app_server_mcp_added", {
                "mcp.server_count": Object.keys(mcpConfig.servers).length,
                "mcp.servers": Object.keys(mcpConfig.servers).join(", "),
            });
        }

        const settings: CodexAppServerSettings = {
            cwd: context.workingDirectory,
            mcpServers: mcpServersConfig,
            approvalMode: "on-failure",
            sandboxMode: "workspace-write",
            reasoningEffort: context.reasoningEffort,
            verbose: false,
            logger: {
                warn: (message: string) => logger.warn("[CodexAppServer]", message),
                error: (message: string) => logger.error("[CodexAppServer]", message),
                info: (message: string) => logger.info("[CodexAppServer]", message),
                debug: (message: string) => logger.debug("[CodexAppServer]", message),
            },
            onSessionCreated: (session: Session) => {
                this.currentSession = session;
                logger.info("[CodexAppServerProvider] Session created", {
                    threadId: session.threadId,
                    reasoningEffort: context.reasoningEffort,
                });
                trace.getActiveSpan()?.addEvent("codex_app_server.session_created", {
                    "session.threadId": session.threadId,
                    "reasoning.effort": context.reasoningEffort ?? "default",
                });
            },
        };

        if (context.sessionId) {
            settings.resume = context.sessionId;
        }

        return settings;
    }

    /**
     * Codex App Server is always available (no API key required)
     */
    isAvailable(): boolean {
        return this._initialized;
    }
}
