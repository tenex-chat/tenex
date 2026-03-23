import { trace } from "@opentelemetry/api";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { LanguageModel, LanguageModelMiddleware } from "ai";
import {
    CONTEXT_MANAGEMENT_KEY,
    ContextUtilizationReminderStrategy,
    ContextWindowStatusStrategy,
    ScratchpadStrategy,
    SummarizationStrategy,
    SystemPromptCachingStrategy,
    ToolResultDecayStrategy,
    createContextManagementRuntime,
    createDefaultPromptTokenEstimator,
    type ContextManagementRequestContext,
    type ContextManagementRuntime,
    type ContextManagementStrategy,
    type DecayedToolContext,
} from "ai-sdk-context-management";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import { resolveToolCallEventIdMap } from "@/conversations/utils/resolve-tool-call-event-id-map";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { getContextWindow } from "@/llm/utils/context-window-cache";
import { config as configService } from "@/services/ConfigService";
import { isOnlyToolMode, type NudgeToolPermissions } from "@/services/nudge";
import type { AISdkTool } from "@/tools/types";
import {
    buildDecayPlaceholder,
    createManagedContextBudgetProfile,
    normalizeProviderId,
} from "./budget-profile";
import { getContextManagementSettings } from "./settings";
import {
    fromRuntimeScratchpadState,
    toRuntimeScratchpadConversationEntries,
    toRuntimeScratchpadState,
} from "./scratchpad-store";
import { createTelemetryCallback } from "./telemetry";

export interface ExecutionContextManagement {
    middleware: LanguageModelMiddleware;
    optionalTools: Record<string, AISdkTool>;
    requestContext: ContextManagementRequestContext;
}

function createSummarizationModel(options: {
    conversationId: string;
    agent: AgentInstance;
}): LanguageModel | undefined {
    try {
        const configName = configService.getSummarizationModelName();
        const llmService = configService.createLLMService(configName, {
            agentName: "context-summarizer",
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
    scratchpadAvailable: boolean;
}): ContextManagementRuntime {
    const settings = getContextManagementSettings();
    const requestEstimator = createDefaultPromptTokenEstimator();
    const managedBudgetProfile = createManagedContextBudgetProfile(
        settings.tokenBudget,
        requestEstimator
    );
    const scratchpadEnabled = settings.scratchpadEnabled && options.scratchpadAvailable;

    const strategies: ContextManagementStrategy[] = [
        new SystemPromptCachingStrategy(),
        new ToolResultDecayStrategy({
            estimator: requestEstimator,
            placeholder: ({ toolName, toolCallId }: DecayedToolContext) => {
                const toolCallEventIdMap = resolveToolCallEventIdMap(
                    options.conversationStore.getAllMessages()
                );
                return buildDecayPlaceholder(toolName, toolCallId, toolCallEventIdMap);
            },
        }),
    ];

    const summarizationModel = createSummarizationModel({
        conversationId: options.conversationId,
        agent: options.agent,
    });

    if (summarizationModel && settings.summarizationFallbackEnabled) {
        strategies.push(
            new SummarizationStrategy({
                model: summarizationModel,
                maxPromptTokens: Math.floor(
                    settings.tokenBudget
                        * (settings.summarizationFallbackThresholdPercent / 100)
                ),
                estimator: managedBudgetProfile.estimator,
            })
        );
    }

    if (scratchpadEnabled) {
        strategies.push(
            new ScratchpadStrategy({
                scratchpadStore: {
                    get: ({ agentId }) =>
                        toRuntimeScratchpadState(
                            options.conversationStore.getContextManagementScratchpad(agentId)
                        ),
                    set: async ({ agentId }, state) => {
                        options.conversationStore.setContextManagementScratchpad(
                            agentId,
                            fromRuntimeScratchpadState(
                                state,
                                options.conversationStore.getContextManagementScratchpad(agentId)
                            )
                        );
                        await options.conversationStore.save();
                    },
                    listConversation: (conversationId) =>
                        conversationId === options.conversationStore.getId()
                            ? toRuntimeScratchpadConversationEntries(
                                options.conversationStore.listContextManagementScratchpads()
                            )
                            : [],
                },
                reminderTone: "informational",
                budgetProfile: managedBudgetProfile,
                forceToolThresholdRatio: settings.forceScratchpadEnabled
                    ? settings.forceScratchpadThresholdPercent / 100
                    : undefined,
            })
        );
    }

    if (settings.utilizationWarningEnabled) {
        strategies.push(
            new ContextUtilizationReminderStrategy({
                budgetProfile: managedBudgetProfile,
                warningThresholdRatio: settings.utilizationWarningThresholdPercent / 100,
                mode: scratchpadEnabled ? "scratchpad" : "generic",
            })
        );
    }

    strategies.push(
        new ContextWindowStatusStrategy({
            budgetProfile: managedBudgetProfile,
            requestEstimator,
            getContextWindow: ({ model }) => {
                if (!model) {
                    return undefined;
                }

                return getContextWindow(
                    normalizeProviderId(model.provider),
                    model.modelId
                );
            },
        })
    );

    const telemetry = createTelemetryCallback();
    const runtime = createContextManagementRuntime({
        strategies,
        telemetry: telemetry.emit,
        estimator: requestEstimator,
        systemReminderContext: getSystemReminderContext(),
    });

    const middleware: LanguageModelMiddleware = {
        specificationVersion: "v3",
        transformParams: async (args) => {
            const transformed = await runtime.middleware.transformParams?.(args as never)
                ?? args.params;
            telemetry.finalizeRuntimeComplete(transformed as Partial<LanguageModelV3CallOptions>);
            return transformed;
        },
    };

    return {
        ...runtime,
        middleware,
    };
}

export function createExecutionContextManagement(options: {
    providerId: string;
    conversationId: string;
    agent: AgentInstance;
    conversationStore: ConversationStore;
    nudgeToolPermissions?: NudgeToolPermissions;
}): ExecutionContextManagement | undefined {
    const settings = getContextManagementSettings();

    const scratchpadAvailable =
        settings.scratchpadEnabled
        && (!options.nudgeToolPermissions || !isOnlyToolMode(options.nudgeToolPermissions));

    const runtime = createConversationContextManagementRuntime({
        conversationStore: options.conversationStore,
        conversationId: options.conversationId,
        agent: options.agent,
        scratchpadAvailable,
    });
    const optionalTools = scratchpadAvailable
        ? (runtime.optionalTools as unknown as Record<string, AISdkTool>)
        : {};

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
