import {
    createCodexAppServer,
    type CodexAppServerProvider as CodexAppServerInstance,
    type CodexAppServerRequestHandlers,
    type CodexAppServerSession,
    type CodexAppServerSettings,
} from "ai-sdk-provider-codex-cli";
import type { LanguageModelUsage } from "ai";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
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
import { createSdkMcpServer } from "./CodexToolsAdapter";
import { PROVIDER_IDS } from "../provider-ids";

const CODEX_APP_SERVER_METADATA_KEY = "codex-app-server";
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const INTERNAL_TENEX_MCP_SERVER_BASENAME = "tenex";
const CODEX_COMMAND_REMINDER_TYPE = "codex-native-command-disabled";
const CODEX_FILE_CHANGE_REMINDER_TYPE = "codex-native-file-change-disabled";
const CODEX_SKILL_REMINDER_TYPE = "codex-native-skill-disabled";
const CODEX_TENEX_TOOL_ROUTING_GUIDANCE = [
    "Prefer TENEX tools over native Codex actions in TENEX.",
    "Do not use native Codex command execution, file changes, or skill loading.",
    "Use `shell` for commands, `fs_read`/`fs_write`/`fs_edit`/`fs_glob`/`fs_grep` for filesystem work, and attached MCP tools for browser, web, and specialized tasks.",
].join(" ");
const CODEX_COMMAND_FALLBACK_GUIDANCE = [
    CODEX_TENEX_TOOL_ROUTING_GUIDANCE,
    "Your native command execution request was rejected. Retry with the TENEX `shell` tool instead.",
].join(" ");
const CODEX_FILE_CHANGE_FALLBACK_GUIDANCE = [
    CODEX_TENEX_TOOL_ROUTING_GUIDANCE,
    "Your native file change request was rejected. Retry with TENEX filesystem tools such as `fs_read`, `fs_edit`, `fs_write`, `fs_glob`, or `fs_grep` instead.",
].join(" ");
const CODEX_SKILL_FALLBACK_GUIDANCE = [
    CODEX_TENEX_TOOL_ROUTING_GUIDANCE,
    "Your native Codex skill request was rejected. Use TENEX-provided MCP tools, filesystem tools, and shell tooling instead of Codex-native skills.",
].join(" ");

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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getConfigOverrideMcpServerNames(
    configOverrides: CodexAppServerSettings["configOverrides"] | undefined
): string[] {
    if (!isRecord(configOverrides)) {
        return [];
    }

    const mcpServers = configOverrides.mcp_servers;
    return isRecord(mcpServers) ? Object.keys(mcpServers) : [];
}

function chooseInternalMcpServerName(
    reservedNames: Iterable<string>
): string {
    const usedNames = new Set(reservedNames);
    if (!usedNames.has(INTERNAL_TENEX_MCP_SERVER_BASENAME)) {
        return INTERNAL_TENEX_MCP_SERVER_BASENAME;
    }

    let suffix = 2;
    while (usedNames.has(`${INTERNAL_TENEX_MCP_SERVER_BASENAME}_${suffix}`)) {
        suffix += 1;
    }

    return `${INTERNAL_TENEX_MCP_SERVER_BASENAME}_${suffix}`;
}

function normalizeLegacyCodexConfigOverrides(
    configOverrides: CodexAppServerSettings["configOverrides"] | undefined
): {
    configOverrides: CodexAppServerSettings["configOverrides"] | undefined;
    migratedServerNames: string[];
} {
    if (!isRecord(configOverrides)) {
        return { configOverrides, migratedServerNames: [] };
    }

    const mcpServers = configOverrides.mcp_servers;
    if (!isRecord(mcpServers)) {
        return { configOverrides, migratedServerNames: [] };
    }

    let changed = false;
    const migratedServerNames: string[] = [];
    const normalizedMcpServers: Record<string, unknown> = { ...mcpServers };

    for (const [serverName, rawServerConfig] of Object.entries(mcpServers)) {
        if (!isRecord(rawServerConfig)) {
            continue;
        }

        const bearerToken = rawServerConfig.bearer_token;
        if (typeof bearerToken !== "string" || bearerToken.length === 0) {
            continue;
        }

        const httpHeaders = isRecord(rawServerConfig.http_headers)
            ? { ...rawServerConfig.http_headers }
            : {};

        if (typeof httpHeaders.Authorization !== "string") {
            httpHeaders.Authorization = `Bearer ${bearerToken}`;
        }

        const { bearer_token: _legacyBearerToken, ...restServerConfig } = rawServerConfig;
        normalizedMcpServers[serverName] = {
            ...restServerConfig,
            http_headers: httpHeaders,
        };
        migratedServerNames.push(serverName);
        changed = true;
    }

    if (!changed) {
        return { configOverrides, migratedServerNames: [] };
    }

    return {
        configOverrides: {
            ...configOverrides,
            mcp_servers: normalizedMcpServers,
        },
        migratedServerNames,
    };
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

/**
 * Build the Codex baseInstructions, which always includes the TENEX tool routing
 * guidance. baseInstructions has lower priority than developerInstructions, so
 * this allows the Codex provider library to fall back to using the system prompt
 * (extracted from role:"system" messages) as developerInstructions.
 *
 * When developerInstructions is left unset, the library's fallback logic
 * (`effectiveDeveloperInstructions = developerInstructionsOverride ?? prompt.systemInstruction`)
 * kicks in and uses the TENEX system prompt (agent identity, project context,
 * skills, etc.) as developerInstructions — which is exactly what we want.
 */
function buildCodexBaseInstructions(
    baseInstructions: string | undefined
): string {
    if (baseInstructions?.includes(CODEX_TENEX_TOOL_ROUTING_GUIDANCE)) {
        return baseInstructions;
    }

    return baseInstructions
        ? `${CODEX_TENEX_TOOL_ROUTING_GUIDANCE}\n\n${baseInstructions}`
        : CODEX_TENEX_TOOL_ROUTING_GUIDANCE;
}

function createTenexToolRoutingHandlers(options: {
    agentName?: string;
    getActiveSession: () => CodexAppServerSession | null;
}): Pick<CodexAppServerRequestHandlers, "onCommandExecutionApproval" | "onFileChangeApproval" | "onSkillApproval"> {
    const remindedRequestKeys = new Set<string>();

    const queueReminder = async (key: string, reminderType: string, reminderContent: string): Promise<void> => {
        if (remindedRequestKeys.has(key)) {
            return;
        }
        remindedRequestKeys.add(key);

        getSystemReminderContext().queue({
            type: reminderType,
            content: reminderContent,
        });

        const session = options.getActiveSession();
        if (session) {
            try {
                await session.injectMessage(reminderContent);
            } catch (error) {
                logger.warn("[CodexProvider] Failed to inject TENEX tool routing guidance", {
                    error: error instanceof Error ? error.message : String(error),
                    threadId: session.threadId,
                });
            }
        }
    };

    return {
        onCommandExecutionApproval: async (request) => {
            const turnKey = `command:${request.params.turnId ?? request.params.itemId ?? String(request.id)}`;
            const command = request.params.command?.trim();
            const reminderContent = command
                ? `${CODEX_COMMAND_FALLBACK_GUIDANCE} Rejected native command: ${command}.`
                : CODEX_COMMAND_FALLBACK_GUIDANCE;

            await queueReminder(turnKey, CODEX_COMMAND_REMINDER_TYPE, reminderContent);

            logger.info("[CodexProvider] Rejected native command execution request", {
                agentName: options.agentName,
                command: command ?? "(unknown)",
                turnId: request.params.turnId ?? undefined,
            });
            trace.getActiveSpan()?.addEvent("codex.native_command_rejected", {
                "agent.name": options.agentName ?? "",
                "command.value": command ?? "",
                "turn.id": request.params.turnId ?? "",
            });

            return { decision: "decline" };
        },
        onFileChangeApproval: async (request) => {
            const turnKey = `file-change:${request.params.turnId ?? request.params.itemId ?? String(request.id)}`;
            const reason = request.params.reason?.trim();
            const reminderContent = reason
                ? `${CODEX_FILE_CHANGE_FALLBACK_GUIDANCE} Rejected native file change reason: ${reason}.`
                : CODEX_FILE_CHANGE_FALLBACK_GUIDANCE;

            await queueReminder(turnKey, CODEX_FILE_CHANGE_REMINDER_TYPE, reminderContent);

            logger.info("[CodexProvider] Rejected native file change request", {
                agentName: options.agentName,
                turnId: request.params.turnId ?? undefined,
                grantRoot: request.params.grantRoot ?? undefined,
            });
            trace.getActiveSpan()?.addEvent("codex.native_file_change_rejected", {
                "agent.name": options.agentName ?? "",
                "turn.id": request.params.turnId ?? "",
                "grant_root": request.params.grantRoot ?? "",
            });

            return { decision: "decline" };
        },
        onSkillApproval: async (request) => {
            const turnKey = `skill:${request.params.itemId}`;
            const reminderContent =
                `${CODEX_SKILL_FALLBACK_GUIDANCE} Rejected native skill: ${request.params.skillName}.`;

            await queueReminder(turnKey, CODEX_SKILL_REMINDER_TYPE, reminderContent);

            logger.info("[CodexProvider] Rejected native skill request", {
                agentName: options.agentName,
                skillName: request.params.skillName,
            });
            trace.getActiveSpan()?.addEvent("codex.native_skill_rejected", {
                "agent.name": options.agentName ?? "",
                "skill.name": request.params.skillName,
            });

            return { decision: "decline" };
        },
    };
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
        const {
            configOverrides: normalizedConfigOverrides,
            migratedServerNames,
        } = normalizeLegacyCodexConfigOverrides(providerConfig.configOverrides);

        trace.getActiveSpan()?.addEvent("llm_factory.creating_codex", {
            "agent.name": context.agentName ?? "",
        });

        if (migratedServerNames.length > 0) {
            logger.warn("[CodexProvider] Normalized legacy MCP bearer_token overrides", {
                serverNames: migratedServerNames,
            });
            trace.getActiveSpan()?.addEvent("codex.config_overrides_normalized", {
                "mcp.server_count": migratedServerNames.length,
                "mcp.servers": migratedServerNames.join(", "),
            });
        }

        const allTools = context.tools;
        const toolNames = allTools ? Object.keys(allTools) : [];
        const regularTools = toolNames.filter((name) => !name.startsWith("mcp__"));
        const tenexTools = allTools
            ? Object.fromEntries(regularTools.map((name) => [name, allTools[name]]))
            : undefined;

        const reservedMcpServerNames = new Set<string>([
            ...Object.keys(context.mcpConfig?.servers ?? {}),
            ...getConfigOverrideMcpServerNames(normalizedConfigOverrides),
        ]);
        const internalTenexServerName = chooseInternalMcpServerName(reservedMcpServerNames);

        logger.debug("[CodexProvider] Tool analysis", {
            agentName: context.agentName,
            totalToolNames: toolNames.length,
            regularTools: regularTools.length,
            internalTenexServerName,
        });

        const mcpServersConfig: NonNullable<CodexAppServerSettings["mcpServers"]> = {};

        if (tenexTools && regularTools.length > 0) {
            const tenexServer = createSdkMcpServer(
                tenexTools,
                {
                    agentName: context.agentName,
                    serverName: internalTenexServerName,
                }
            );
            if (tenexServer) {
                mcpServersConfig[internalTenexServerName] = tenexServer;
                logger.debug("[CodexProvider] Added TENEX SDK MCP server", {
                    serverName: internalTenexServerName,
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
        let activeSession: CodexAppServerSession | null = null;

        const serverRequests: CodexAppServerRequestHandlers = createTenexToolRoutingHandlers({
            agentName: context.agentName,
            getActiveSession: () => activeSession,
        });

        const approvalPolicy: CodexApprovalPolicy = "on-request";

        if (providerConfig.approvalPolicy && providerConfig.approvalPolicy !== "on-request") {
            logger.warn("[CodexProvider] Overriding Codex approval policy to enforce TENEX tool routing", {
                requestedApprovalPolicy: providerConfig.approvalPolicy,
                enforcedApprovalPolicy: approvalPolicy,
            });
            trace.getActiveSpan()?.addEvent("codex.approval_policy_overridden", {
                "approval.requested": providerConfig.approvalPolicy,
                "approval.enforced": approvalPolicy,
            });
        }

        const settings: CodexAppServerSettings = {
            cwd: context.workingDirectory,
            approvalPolicy,
            sandboxPolicy: providerConfig.sandboxPolicy ?? "workspace-write",
            threadMode: "stateless",
            effort: providerConfig.effort,
            summary: providerConfig.summary,
            personality: providerConfig.personality,
            // Do NOT set developerInstructions here unless the user explicitly configured it.
            // The ai-sdk-provider-codex-cli library falls back to using the system prompt
            // (extracted from role:"system" messages) as developerInstructions when this
            // field is unset. This allows the TENEX system prompt (agent identity, project
            // context, skills, etc.) to reach Codex as developerInstructions.
            // See: effectiveDeveloperInstructions = developerInstructionsOverride ?? prompt.systemInstruction
            developerInstructions: providerConfig.developerInstructions,
            // TENEX tool routing guidance goes into baseInstructions so Codex always
            // receives it regardless of whether developerInstructions is set or not.
            baseInstructions: buildCodexBaseInstructions(providerConfig.baseInstructions),
            mcpServers: Object.keys(mcpServersConfig).length > 0 ? mcpServersConfig : undefined,
            rmcpClient: providerConfig.rmcpClient,
            configOverrides: normalizedConfigOverrides,
            serverRequests,
            idleTimeoutMs,
            verbose: false,
            logger: createCodexLogger(),
            onSessionCreated: async (session: CodexAppServerSession) => {
                activeSession = session;
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
            toolOtherCalls:
                toolStats?.byType?.other !== undefined || toolStats?.byType?.web_search !== undefined
                    ? (toolStats?.byType?.other ?? 0) + (toolStats?.byType?.web_search ?? 0)
                    : undefined,
        };

        return hasDefinedMetadata(normalizedMetadata) ? normalizedMetadata : undefined;
    }
}
