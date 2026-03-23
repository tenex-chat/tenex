import {
    createClaudeCode,
    type ClaudeCodeProvider as ClaudeCodeProviderInstance,
    type ClaudeCodeSettings,
} from "ai-sdk-provider-claude-code";
import type { LanguageModelUsage } from "ai";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type { LLMMetadata, LanguageModelUsageWithCostUsd } from "../../types";
import type {
    ProviderInitConfig,
    ProviderMetadata,
    ProviderRuntimeContext,
} from "../types";
import { AgentProvider, type AgentProviderFunction } from "../base/AgentProvider";
import { ClaudeToolsAdapter } from "./ClaudeToolsAdapter";
import { PROVIDER_IDS } from "../provider-ids";

const CLAUDE_CODE_METADATA_KEY = "claude-code";
const DEFAULT_MAX_TURNS = 25;

type ClaudeEffort = NonNullable<ClaudeCodeSettings["effort"]>;
type ClaudePermissionMode = NonNullable<ClaudeCodeSettings["permissionMode"]>;
type ClaudeThinking = NonNullable<ClaudeCodeSettings["thinking"]>;

interface ClaudeProviderConfig {
    effort?: ClaudeEffort;
    maxTurns?: number;
    permissionMode?: ClaudePermissionMode;
    thinking?: ClaudeThinking;
    allowedTools?: string[];
    disallowedTools?: string[];
    additionalDirectories?: string[];
    env?: Record<string, string | undefined>;
}

interface ClaudeCodeProviderMetadata {
    costUsd?: number;
    sessionId?: string;
    durationMs?: number;
}

interface ExtendedUsage extends LanguageModelUsage {
    cachedInputTokens?: number;
    reasoningTokens?: number;
}

function createClaudeLogger(): {
    warn: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
    debug: (message: string) => void;
} {
    return {
        warn: (message: string) => logger.warn("[Claude]", message),
        error: (message: string) => logger.error("[Claude]", message),
        info: (message: string) => logger.info("[Claude]", message),
        debug: (message: string) => logger.debug("[Claude]", message),
    };
}

function hasDefinedMetadata(metadata: LLMMetadata): boolean {
    return Object.values(metadata).some((value) => value !== undefined);
}

export class ClaudeProvider extends AgentProvider {
    static readonly METADATA: ProviderMetadata = AgentProvider.createMetadata(
        PROVIDER_IDS.CLAUDE,
        "Claude Code",
        "Anthropic Claude via Agent SDK with built-in tools and session management",
        "agent",
        "sonnet",
        {
            streaming: true,
            toolCalling: true,
            builtInTools: true,
            requiresApiKey: false,
            mcpSupport: true,
        },
        "https://docs.anthropic.com/en/docs/claude-code"
    );

    private claudeProvider: ClaudeCodeProviderInstance | null = null;

    get metadata(): ProviderMetadata {
        return ClaudeProvider.METADATA;
    }

    protected createProviderFunction(_config: ProviderInitConfig): AgentProviderFunction {
        this.claudeProvider = createClaudeCode({
            defaultSettings: {
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                maxTurns: DEFAULT_MAX_TURNS,
                thinking: { type: "adaptive" },
                persistSession: false,
                verbose: false,
                logger: createClaudeLogger(),
            },
        });

        return this.claudeProvider as unknown as AgentProviderFunction;
    }

    protected createAgentSettings(
        context: ProviderRuntimeContext,
        _modelId: string
    ): ClaudeCodeSettings {
        const providerConfig = (context.providerConfig ?? {}) as ClaudeProviderConfig;

        trace.getActiveSpan()?.addEvent("llm_factory.creating_claude", {
            "agent.name": context.agentName ?? "",
        });

        const allTools = context.tools;
        const toolNames = allTools ? Object.keys(allTools) : [];
        const regularTools = toolNames.filter((name) => !name.startsWith("mcp__"));
        const tenexTools = allTools
            ? Object.fromEntries(regularTools.map((name) => [name, allTools[name]]))
            : undefined;

        logger.debug("[ClaudeProvider] Tool analysis", {
            agentName: context.agentName,
            totalToolNames: toolNames.length,
            regularTools: regularTools.length,
        });

        const mcpServersConfig: NonNullable<ClaudeCodeSettings["mcpServers"]> = {};

        if (tenexTools && regularTools.length > 0) {
            const tenexServer = ClaudeToolsAdapter.createSdkMcpServer(tenexTools, {
                agentName: context.agentName,
            });
            if (tenexServer) {
                mcpServersConfig.tenex = tenexServer;
                logger.debug("[ClaudeProvider] Added TENEX SDK MCP server", {
                    toolCount: regularTools.length,
                });
            }
        }

        const mcpConfig = context.mcpConfig;
        if (mcpConfig?.enabled && mcpConfig.servers) {
            for (const [serverName, serverConfig] of Object.entries(mcpConfig.servers)) {
                mcpServersConfig[serverName] = {
                    type: "stdio",
                    command: serverConfig.command,
                    args: serverConfig.args,
                    env: serverConfig.env,
                };
            }

            trace.getActiveSpan()?.addEvent("llm_factory.claude_mcp_added", {
                "mcp.server_count": Object.keys(mcpConfig.servers).length,
                "mcp.servers": Object.keys(mcpConfig.servers).join(", "),
            });
        }

        const permissionMode = providerConfig.permissionMode ?? "bypassPermissions";

        return {
            cwd: context.workingDirectory,
            permissionMode,
            allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
            maxTurns: providerConfig.maxTurns ?? DEFAULT_MAX_TURNS,
            thinking: providerConfig.thinking ?? { type: "adaptive" },
            effort: providerConfig.effort,
            allowedTools: providerConfig.allowedTools,
            disallowedTools: providerConfig.disallowedTools,
            additionalDirectories: providerConfig.additionalDirectories,
            env: providerConfig.env,
            mcpServers: Object.keys(mcpServersConfig).length > 0 ? mcpServersConfig : undefined,
            persistSession: false,
            verbose: false,
            logger: createClaudeLogger(),
            streamingInput: context.onStreamStart ? "always" : undefined,
            onStreamStart: context.onStreamStart,
        };
    }

    isAvailable(): boolean {
        return this._initialized;
    }

    reset(): void {
        this.claudeProvider = null;
        super.reset();
    }

    static extractUsageMetadata(
        model: string,
        totalUsage: LanguageModelUsage | undefined,
        providerMetadata: Record<string, unknown> | undefined
    ): LanguageModelUsageWithCostUsd {
        const metadata = providerMetadata?.[CLAUDE_CODE_METADATA_KEY] as ClaudeCodeProviderMetadata | undefined;
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

    static extractMetadata(
        providerMetadata: Record<string, unknown> | undefined
    ): LLMMetadata | undefined {
        const metadata = providerMetadata?.[CLAUDE_CODE_METADATA_KEY] as ClaudeCodeProviderMetadata | undefined;

        const normalizedMetadata: LLMMetadata = {
            threadId: metadata?.sessionId,
        };

        return hasDefinedMetadata(normalizedMetadata) ? normalizedMetadata : undefined;
    }
}
