import {
    createCodexAppServer,
    type CodexAppServerProvider as CodexAppServerInstance,
    type CodexAppServerSession,
    type CodexAppServerSettings,
} from "ai-sdk-provider-codex-cli";
import type { LanguageModelUsage } from "ai";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type {
    LLMMetadata,
    LanguageModelUsageWithCostUsd,
    MessageInjector,
} from "../../types";
import type {
    ProviderInitConfig,
    ProviderMetadata,
    ProviderRuntimeContext,
} from "../types";
import { AgentProvider, type AgentProviderFunction } from "../base/AgentProvider";
import { CodexToolsAdapter } from "./CodexToolsAdapter";
import { PROVIDER_IDS } from "../provider-ids";

const CODEX_APP_SERVER_METADATA_KEY = "codex-app-server";
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

type CodexEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
type CodexSummary = "auto" | "concise" | "detailed" | "none";
type CodexPersonality = "none" | "friendly" | "pragmatic";
type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
type CodexSandboxPolicy = "read-only" | "workspace-write" | "danger-full-access";

interface CodexProviderConfig {
    effort?: CodexEffort;
    summary?: CodexSummary;
    personality?: CodexPersonality;
    approvalPolicy?: CodexApprovalPolicy;
    sandboxPolicy?: CodexSandboxPolicy;
    developerInstructions?: string;
    baseInstructions?: string;
    configOverrides?: CodexAppServerSettings["configOverrides"];
    rmcpClient?: boolean;
    idleTimeoutMs?: number;
}

interface CodexToolExecutionStats {
    totalCalls?: number;
    totalDurationMs?: number;
    byType?: {
        exec?: number;
        patch?: number;
        mcp?: number;
        web_search?: number;
        other?: number;
    };
}

interface CodexAppServerProviderMetadata {
    threadId?: string;
    turnId?: string;
    toolExecutionStats?: CodexToolExecutionStats;
}

interface ExtendedUsage extends LanguageModelUsage {
    cachedInputTokens?: number;
    reasoningTokens?: number;
}

function createCodexLogger(): {
    warn: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
    debug: (message: string) => void;
} {
    return {
        warn: (message: string) => logger.warn("[Codex]", message),
        error: (message: string) => logger.error("[Codex]", message),
        info: (message: string) => logger.info("[Codex]", message),
        debug: (message: string) => logger.debug("[Codex]", message),
    };
}

function hasDefinedMetadata(metadata: LLMMetadata): boolean {
    return Object.values(metadata).some((value) => value !== undefined);
}

export class CodexProvider extends AgentProvider {
    static readonly METADATA: ProviderMetadata = AgentProvider.createMetadata(
        PROVIDER_IDS.CODEX,
        "Codex",
        "OpenAI Codex via app-server mode with built-in tools and message injection",
        "agent",
        "gpt-5.1-codex-max",
        {
            streaming: true,
            toolCalling: true,
            builtInTools: true,
            requiresApiKey: false,
            mcpSupport: true,
        },
        "https://openai.com/codex"
    );

    private codexProvider: CodexAppServerInstance | null = null;

    get metadata(): ProviderMetadata {
        return CodexProvider.METADATA;
    }

    protected createProviderFunction(_config: ProviderInitConfig): AgentProviderFunction {
        this.codexProvider = createCodexAppServer({
            defaultSettings: {
                approvalPolicy: "on-failure",
                sandboxPolicy: "workspace-write",
                threadMode: "stateless",
                idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
                verbose: false,
                logger: createCodexLogger(),
            },
        });

        return this.codexProvider as unknown as AgentProviderFunction;
    }

    protected createAgentSettings(
        context: ProviderRuntimeContext,
        _modelId: string
    ): CodexAppServerSettings {
        const providerConfig = (context.providerConfig ?? {}) as CodexProviderConfig;

        trace.getActiveSpan()?.addEvent("llm_factory.creating_codex", {
            "agent.name": context.agentName ?? "",
        });

        const allTools = context.tools;
        const toolNames = allTools ? Object.keys(allTools) : [];
        const regularTools = toolNames.filter((name) => !name.startsWith("mcp__"));
        const tenexTools = allTools
            ? Object.fromEntries(regularTools.map((name) => [name, allTools[name]]))
            : undefined;

        logger.debug("[CodexProvider] Tool analysis", {
            agentName: context.agentName,
            totalToolNames: toolNames.length,
            regularTools: regularTools.length,
        });

        const mcpServersConfig: NonNullable<CodexAppServerSettings["mcpServers"]> = {};

        if (tenexTools && regularTools.length > 0) {
            const tenexServer = CodexToolsAdapter.createSdkMcpServer(
                tenexTools,
                { agentName: context.agentName }
            );
            if (tenexServer) {
                mcpServersConfig.tenex = tenexServer;
                logger.debug("[CodexProvider] Added TENEX SDK MCP server", {
                    toolCount: regularTools.length,
                });
            }
        }

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

            trace.getActiveSpan()?.addEvent("llm_factory.codex_mcp_added", {
                "mcp.server_count": Object.keys(mcpConfig.servers).length,
                "mcp.servers": Object.keys(mcpConfig.servers).join(", "),
            });
        }

        const idleTimeoutMs = providerConfig.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

        const settings: CodexAppServerSettings = {
            cwd: context.workingDirectory,
            approvalPolicy: providerConfig.approvalPolicy ?? "on-failure",
            sandboxPolicy: providerConfig.sandboxPolicy ?? "workspace-write",
            threadMode: "stateless",
            effort: providerConfig.effort,
            summary: providerConfig.summary,
            personality: providerConfig.personality,
            developerInstructions: providerConfig.developerInstructions,
            baseInstructions: providerConfig.baseInstructions,
            mcpServers: Object.keys(mcpServersConfig).length > 0 ? mcpServersConfig : undefined,
            rmcpClient: providerConfig.rmcpClient,
            configOverrides: providerConfig.configOverrides,
            idleTimeoutMs,
            verbose: false,
            logger: createCodexLogger(),
            onSessionCreated: async (session: CodexAppServerSession) => {
                logger.info("[CodexProvider] Session created", {
                    threadId: session.threadId,
                    effort: providerConfig.effort,
                    threadMode: "stateless",
                });
                trace.getActiveSpan()?.addEvent("codex.session_created", {
                    "session.threadId": session.threadId,
                    "reasoning.effort": providerConfig.effort ?? "default",
                    "session.thread_mode": "stateless",
                });

                if (!context.onStreamStart) {
                    return;
                }

                const injector: MessageInjector = {
                    inject: (message, callback) => {
                        void session.injectMessage(message)
                            .then(() => callback(true))
                            .catch((error) => {
                                logger.warn("[CodexProvider] Message injection failed", {
                                    error: error instanceof Error ? error.message : String(error),
                                });
                                callback(false);
                            });
                    },
                };

                context.onStreamStart(injector);
            },
        };

        return settings;
    }

    isAvailable(): boolean {
        return this._initialized;
    }

    reset(): void {
        const codexProvider = this.codexProvider;
        this.codexProvider = null;

        super.reset();

        if (!codexProvider) {
            return;
        }

        void codexProvider.close().catch((error) => {
            logger.warn("[CodexProvider] Failed to close app-server provider", {
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }

    static extractUsageMetadata(
        model: string,
        totalUsage: LanguageModelUsage | undefined,
        _providerMetadata: Record<string, unknown> | undefined
    ): LanguageModelUsageWithCostUsd {
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
            cachedInputTokens: extendedUsage?.cachedInputTokens,
            reasoningTokens: extendedUsage?.reasoningTokens,
        } as LanguageModelUsageWithCostUsd;
    }

    static extractMetadata(
        providerMetadata: Record<string, unknown> | undefined
    ): LLMMetadata | undefined {
        const metadata = providerMetadata?.[CODEX_APP_SERVER_METADATA_KEY] as CodexAppServerProviderMetadata | undefined;
        const toolStats = metadata?.toolExecutionStats;

        const normalizedMetadata: LLMMetadata = {
            threadId: metadata?.threadId,
            turnId: metadata?.turnId,
            toolTotalCalls: toolStats?.totalCalls,
            toolTotalDurationMs: toolStats?.totalDurationMs,
            toolCommandCalls: toolStats?.byType?.exec,
            toolFileChangeCalls: toolStats?.byType?.patch,
            toolMcpCalls: toolStats?.byType?.mcp,
            toolWebSearchCalls: toolStats?.byType?.web_search,
            toolOtherCalls: toolStats?.byType?.other,
        };

        return hasDefinedMetadata(normalizedMetadata) ? normalizedMetadata : undefined;
    }
}
