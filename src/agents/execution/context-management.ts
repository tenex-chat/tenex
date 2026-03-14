import { trace } from "@opentelemetry/api";
import type { LanguageModelMiddleware } from "ai";
import {
    CONTEXT_MANAGEMENT_KEY,
    ContextUtilizationReminderStrategy,
    LLMSummarizationStrategy,
    ScratchpadStrategy,
    SystemPromptCachingStrategy,
    ToolResultDecayStrategy,
    createContextManagementRuntime,
    createDefaultPromptTokenEstimator,
    type ContextManagementRequestContext,
    type ContextManagementRuntime,
    type ContextManagementStrategy,
    type ContextManagementTelemetryEvent,
} from "ai-sdk-context-management";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import { providerRegistry } from "@/llm/providers";
import { config as configService } from "@/services/ConfigService";
import { isOnlyToolMode, type NudgeToolPermissions } from "@/services/nudge";
import type { AISdkTool } from "@/tools/types";

const DEFAULT_WORKING_TOKEN_BUDGET = 40000;
const DEFAULT_WARNING_THRESHOLD_PERCENT = 70;
const DEFAULT_SUMMARIZATION_THRESHOLD_PERCENT = 90;
const DEFAULT_FORCE_SCRATCHPAD_THRESHOLD_PERCENT = 70;
const TOOL_RESULT_DECAY_THRESHOLD_RATIO = 0.6;

interface ResolvedContextManagementConfig {
    enabled: boolean;
    workingTokenBudget: number;
    scratchpadEnabled: boolean;
    forceScratchpadEnabled: boolean;
    forceScratchpadThresholdPercent: number;
    utilizationWarningEnabled: boolean;
    utilizationWarningThresholdPercent: number;
    summarizationFallbackEnabled: boolean;
    summarizationFallbackThresholdPercent: number;
}

export interface ExecutionContextManagement {
    middleware: LanguageModelMiddleware;
    optionalTools: Record<string, AISdkTool>;
    requestContext: ContextManagementRequestContext;
}

function normalizeProviderId(providerId: string): string {
    const normalized = providerId.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    const registered = providerRegistry.getRegisteredProviders();
    const matches = registered.some((metadata) => metadata.id === normalized);

    return matches ? normalized : providerId;
}

function isResumableProvider(providerId: string): boolean {
    const normalized = normalizeProviderId(providerId);
    const provider = providerRegistry.getProvider(normalized);

    if (provider) {
        return provider.metadata.capabilities.sessionResumption === true;
    }

    const registered = providerRegistry
        .getRegisteredProviders()
        .find((metadata) => metadata.id === normalized);
    return registered?.capabilities.sessionResumption === true;
}

function clampPositiveInteger(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return fallback;
    }

    return Math.floor(value);
}

function clampPercent(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.min(100, Math.max(1, Math.floor(value)));
}

function getContextManagementConfig(): ResolvedContextManagementConfig {
    const cfg = (() => {
        try {
            return configService.getConfig();
        } catch {
            return undefined;
        }
    })();

    const contextConfig = {
        ...cfg?.compression,
        ...cfg?.contextManagement,
    };

    return {
        enabled: contextConfig.enabled ?? true,
        workingTokenBudget: clampPositiveInteger(
            contextConfig.tokenBudget,
            DEFAULT_WORKING_TOKEN_BUDGET
        ),
        scratchpadEnabled: contextConfig.scratchpadEnabled ?? true,
        forceScratchpadEnabled: contextConfig.forceScratchpadEnabled ?? true,
        forceScratchpadThresholdPercent: clampPercent(
            contextConfig.forceScratchpadThresholdPercent,
            DEFAULT_FORCE_SCRATCHPAD_THRESHOLD_PERCENT
        ),
        utilizationWarningEnabled: contextConfig.utilizationWarningEnabled ?? true,
        utilizationWarningThresholdPercent: clampPercent(
            contextConfig.utilizationWarningThresholdPercent,
            DEFAULT_WARNING_THRESHOLD_PERCENT
        ),
        summarizationFallbackEnabled: contextConfig.summarizationFallbackEnabled ?? true,
        summarizationFallbackThresholdPercent: clampPercent(
            contextConfig.summarizationFallbackThresholdPercent,
            DEFAULT_SUMMARIZATION_THRESHOLD_PERCENT
        ),
    };
}

function serializeTelemetryValue(value: unknown): string {
    const seen = new WeakSet<object>();

    try {
        return JSON.stringify(value, (_key, current) => {
            if (current instanceof Error) {
                return {
                    name: current.name,
                    message: current.message,
                    stack: current.stack,
                };
            }

            if (typeof current === "bigint") {
                return current.toString();
            }

            if (typeof current === "object" && current !== null) {
                if (seen.has(current)) {
                    return "[Circular]";
                }
                seen.add(current);
            }

            return current;
        }) ?? "null";
    } catch (error) {
        const fallbackError = error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : { message: String(error) };
        return JSON.stringify({
            serializationError: fallbackError,
            fallback: String(value),
        });
    }
}

function addAttribute(
    attributes: Record<string, string | number | boolean>,
    key: string,
    value: string | number | boolean | undefined
): void {
    if (value !== undefined) {
        attributes[key] = value;
    }
}

function buildTelemetryAttributes(
    event: ContextManagementTelemetryEvent
): Record<string, string | number | boolean> {
    const attributes: Record<string, string | number | boolean> = {
        "context_management.request_context_json": serializeTelemetryValue(
            "requestContext" in event ? event.requestContext : null
        ),
    };

    switch (event.type) {
        case "runtime-start":
            attributes["context_management.strategy_names"] = event.strategyNames.join(",");
            attributes["context_management.optional_tool_names"] = event.optionalToolNames.join(",");
            attributes["context_management.estimated_tokens_before"] =
                event.estimatedTokensBefore;
            attributes["context_management.prompt_json"] = serializeTelemetryValue(
                event.payloads.prompt
            );
            attributes["context_management.provider_options_json"] = serializeTelemetryValue(
                event.payloads.providerOptions
            );
            break;
        case "strategy-complete":
            attributes["context_management.strategy_name"] = event.strategyName;
            attributes["context_management.outcome"] = event.outcome;
            attributes["context_management.reason"] = event.reason;
            attributes["context_management.estimated_tokens_before"] =
                event.estimatedTokensBefore;
            attributes["context_management.estimated_tokens_after"] =
                event.estimatedTokensAfter;
            attributes["context_management.removed_tool_exchanges_delta"] =
                event.removedToolExchangesDelta;
            attributes["context_management.removed_tool_exchanges_total"] =
                event.removedToolExchangesTotal;
            attributes["context_management.pinned_tool_call_ids_delta"] =
                event.pinnedToolCallIdsDelta;
            addAttribute(
                attributes,
                "context_management.working_token_budget",
                event.workingTokenBudget
            );
            attributes["context_management.prompt_before_json"] = serializeTelemetryValue(
                event.payloads.promptBefore
            );
            attributes["context_management.prompt_after_json"] = serializeTelemetryValue(
                event.payloads.promptAfter
            );
            attributes["context_management.strategy_payloads_json"] = serializeTelemetryValue(
                event.payloads.strategy ?? null
            );
            break;
        case "tool-execute-start":
            attributes["context_management.tool_name"] = event.toolName;
            addAttribute(
                attributes,
                "context_management.strategy_name",
                event.strategyName
            );
            addAttribute(
                attributes,
                "context_management.tool_call_id",
                event.toolCallId
            );
            attributes["context_management.tool_input_json"] = serializeTelemetryValue(
                event.payloads.input
            );
            break;
        case "tool-execute-complete":
            attributes["context_management.tool_name"] = event.toolName;
            addAttribute(
                attributes,
                "context_management.strategy_name",
                event.strategyName
            );
            addAttribute(
                attributes,
                "context_management.tool_call_id",
                event.toolCallId
            );
            attributes["context_management.tool_input_json"] = serializeTelemetryValue(
                event.payloads.input
            );
            attributes["context_management.tool_result_json"] = serializeTelemetryValue(
                event.payloads.result
            );
            break;
        case "tool-execute-error":
            attributes["context_management.tool_name"] = event.toolName;
            addAttribute(
                attributes,
                "context_management.strategy_name",
                event.strategyName
            );
            addAttribute(
                attributes,
                "context_management.tool_call_id",
                event.toolCallId
            );
            attributes["context_management.tool_input_json"] = serializeTelemetryValue(
                event.payloads.input
            );
            attributes["context_management.tool_error_json"] = serializeTelemetryValue(
                event.payloads.error
            );
            break;
        case "runtime-complete":
            attributes["context_management.estimated_tokens_before"] =
                event.estimatedTokensBefore;
            attributes["context_management.estimated_tokens_after"] =
                event.estimatedTokensAfter;
            attributes["context_management.removed_tool_exchanges_total"] =
                event.removedToolExchangesTotal;
            attributes["context_management.pinned_tool_call_ids_total"] =
                event.pinnedToolCallIdsTotal;
            attributes["context_management.prompt_before_json"] = serializeTelemetryValue(
                event.payloads.promptBefore
            );
            attributes["context_management.prompt_after_json"] = serializeTelemetryValue(
                event.payloads.promptAfter
            );
            break;
    }

    return attributes;
}

function emitTelemetryEvent(event: ContextManagementTelemetryEvent): void {
    const span = trace.getActiveSpan();
    if (!span) {
        return;
    }

    const eventName = (() => {
        switch (event.type) {
            case "runtime-start":
                return "context_management.runtime_start";
            case "strategy-complete":
                return "context_management.strategy_complete";
            case "tool-execute-start":
                return "context_management.tool_execute_start";
            case "tool-execute-complete":
                return "context_management.tool_execute_complete";
            case "tool-execute-error":
                return "context_management.tool_execute_error";
            case "runtime-complete":
                return "context_management.runtime_complete";
        }
    })();

    span.addEvent(eventName, buildTelemetryAttributes(event));
}

function createSummarizationModel(options: {
    conversationId: string;
    agent: AgentInstance;
}) {
    try {
        const configName = configService.getSummarizationModelName();
        const llmService = configService.createLLMService(configName, {
            agentName: "context-summarizer",
            sessionId: `context-summarizer-${options.conversationId}-${options.agent.pubkey}`,
            conversationId: options.conversationId,
        });
        return llmService.createLanguageModel();
    } catch {
        trace.getActiveSpan()?.addEvent(
            "context_management.summarization_model_unavailable",
            {
                "context_management.conversation_id": options.conversationId,
                "context_management.agent_id": options.agent.pubkey,
            }
        );
        return undefined;
    }
}

function createConversationContextManagementRuntime(options: {
    conversationStore: ConversationStore;
    conversationId: string;
    agent: AgentInstance;
    config: ResolvedContextManagementConfig;
    scratchpadAvailable: boolean;
}): ContextManagementRuntime {
    const estimator = createDefaultPromptTokenEstimator();
    const strategies: ContextManagementStrategy[] = [
        new SystemPromptCachingStrategy(),
        new ToolResultDecayStrategy({
            maxPromptTokens: Math.floor(
                options.config.workingTokenBudget * TOOL_RESULT_DECAY_THRESHOLD_RATIO
            ),
            estimator,
        }),
    ];

    if (options.config.summarizationFallbackEnabled) {
        const summarizationModel = createSummarizationModel({
            conversationId: options.conversationId,
            agent: options.agent,
        });

        if (summarizationModel) {
            strategies.push(
                new LLMSummarizationStrategy({
                    model: summarizationModel,
                    maxPromptTokens: Math.floor(
                        options.config.workingTokenBudget *
                            (options.config.summarizationFallbackThresholdPercent / 100)
                    ),
                    estimator,
                })
            );
        }
    }

    if (options.config.scratchpadEnabled && options.scratchpadAvailable) {
        strategies.push(
            new ScratchpadStrategy({
                scratchpadStore: {
                    get: ({ agentId }) =>
                        options.conversationStore.getContextManagementScratchpad(agentId),
                    set: async ({ agentId }, state) => {
                        options.conversationStore.setContextManagementScratchpad(agentId, state);
                        await options.conversationStore.save();
                    },
                    listConversation: (conversationId) =>
                        conversationId === options.conversationStore.getId()
                            ? options.conversationStore.listContextManagementScratchpads()
                            : [],
                },
                reminderTone: "informational",
                workingTokenBudget: options.config.workingTokenBudget,
                forceToolThresholdRatio: options.config.forceScratchpadEnabled
                    ? options.config.forceScratchpadThresholdPercent / 100
                    : undefined,
                estimator,
            })
        );
    }

    if (options.config.utilizationWarningEnabled) {
        strategies.push(
            new ContextUtilizationReminderStrategy({
                workingTokenBudget: options.config.workingTokenBudget,
                warningThresholdRatio:
                    options.config.utilizationWarningThresholdPercent / 100,
                mode: options.config.scratchpadEnabled && options.scratchpadAvailable
                    ? "scratchpad"
                    : "generic",
                estimator,
            })
        );
    }

    return createContextManagementRuntime({
        strategies,
        telemetry: emitTelemetryEvent,
        estimator,
    });
}

export function createExecutionContextManagement(options: {
    providerId: string;
    conversationId: string;
    agent: AgentInstance;
    conversationStore: ConversationStore;
    nudgeToolPermissions?: NudgeToolPermissions;
}): ExecutionContextManagement | undefined {
    const config = getContextManagementConfig();
    if (!config.enabled || isResumableProvider(options.providerId)) {
        return undefined;
    }

    const scratchpadAvailable =
        !options.nudgeToolPermissions || !isOnlyToolMode(options.nudgeToolPermissions);

    const runtime = createConversationContextManagementRuntime({
        conversationStore: options.conversationStore,
        conversationId: options.conversationId,
        agent: options.agent,
        config,
        scratchpadAvailable,
    });
    const optionalTools =
        scratchpadAvailable ? (runtime.optionalTools as Record<string, AISdkTool>) : {};

    return {
        middleware: runtime.middleware as LanguageModelMiddleware,
        optionalTools,
        requestContext: {
            conversationId: options.conversationId,
            agentId: options.agent.pubkey,
            agentLabel: options.agent.name || options.agent.slug,
        },
    };
}

export { CONTEXT_MANAGEMENT_KEY };
