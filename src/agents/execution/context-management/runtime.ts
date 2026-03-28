import { trace } from "@opentelemetry/api";
import type { LanguageModel } from "ai";
import {
    CONTEXT_MANAGEMENT_KEY,
    ContextUtilizationReminderStrategy,
    ContextWindowStatusStrategy,
    type ContextManagementPreparedRequest,
    ScratchpadStrategy,
    SummarizationStrategy,
    SystemPromptCachingStrategy,
    ToolResultDecayStrategy,
    createContextManagementRuntime,
    createDefaultPromptTokenEstimator,
    type PrepareContextManagementRequestOptions,
    type ContextManagementRequestContext,
    type ContextManagementRuntime,
    type ContextManagementStrategy,
    type DecayedToolContext,
} from "ai-sdk-context-management";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
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
import { normalizeMessagesForContextManagement } from "./normalize-messages";
import {
    DEFAULT_TOOL_RESULT_DECAY_THRESHOLD_PERCENT,
    getContextManagementSettings,
} from "./settings";
import {
    fromRuntimeScratchpadState,
    toRuntimeScratchpadConversationEntries,
    toRuntimeScratchpadState,
} from "./scratchpad-store";
import { createTelemetryCallback } from "./telemetry";

export interface ExecutionContextManagement {
    optionalTools: Record<string, AISdkTool>;
    requestContext: ContextManagementRequestContext;
    prepareRequest(
        options: Omit<PrepareContextManagementRequestOptions, "requestContext">
    ): Promise<ContextManagementPreparedRequest>;
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
}): {
    runtime: ContextManagementRuntime;
} {
    const settings = getContextManagementSettings();
    const requestEstimator = createDefaultPromptTokenEstimator();
    const managedBudgetProfile = createManagedContextBudgetProfile(
        settings.tokenBudget,
        requestEstimator
    );
    const scratchpadEnabled = options.scratchpadAvailable;
    const toolResultDecayThresholdTokens = Math.floor(
        settings.tokenBudget
            * (DEFAULT_TOOL_RESULT_DECAY_THRESHOLD_PERCENT / 100)
    );

    const strategies: ContextManagementStrategy[] = [
        new SystemPromptCachingStrategy(),
    ];

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
                budgetProfile: managedBudgetProfile,
                forceToolThresholdRatio: settings.forceScratchpadThresholdPercent / 100,
            })
        );
    }

    strategies.push(
        new ToolResultDecayStrategy({
            estimator: managedBudgetProfile.estimator,
            maxPromptTokens: toolResultDecayThresholdTokens,
            placeholder: ({ toolName, toolCallId }: DecayedToolContext) => {
                return buildDecayPlaceholder(toolName, toolCallId);
            },
        })
    );

    const summarizationModel = createSummarizationModel({
        conversationId: options.conversationId,
        agent: options.agent,
    });

    if (summarizationModel) {
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

    strategies.push(
        new ContextUtilizationReminderStrategy({
            budgetProfile: managedBudgetProfile,
            warningThresholdRatio: settings.utilizationWarningThresholdPercent / 100,
            mode: scratchpadEnabled ? "scratchpad" : "generic",
        })
    );

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
        telemetry,
        estimator: requestEstimator,
        systemReminderContext: getSystemReminderContext(),
    });
    return { runtime };
}

export function createExecutionContextManagement(options: {
    providerId: string;
    conversationId: string;
    agent: AgentInstance;
    conversationStore: ConversationStore;
    nudgeToolPermissions?: NudgeToolPermissions;
}): ExecutionContextManagement | undefined {
    const scratchpadAvailable =
        !options.nudgeToolPermissions || !isOnlyToolMode(options.nudgeToolPermissions);

    const { runtime } = createConversationContextManagementRuntime({
        conversationStore: options.conversationStore,
        conversationId: options.conversationId,
        agent: options.agent,
        scratchpadAvailable,
    });
    const optionalTools = scratchpadAvailable
        ? (runtime.optionalTools as unknown as Record<string, AISdkTool>)
        : {};

    return {
        optionalTools,
        requestContext: {
            conversationId: options.conversationId,
            agentId: options.agent.pubkey,
            agentLabel: options.agent.name || options.agent.slug,
        },
        async prepareRequest(requestOptions) {
            return await runtime.prepareRequest({
                ...requestOptions,
                messages: normalizeMessagesForContextManagement(
                    requestOptions.messages
                ),
                requestContext: {
                    conversationId: options.conversationId,
                    agentId: options.agent.pubkey,
                    agentLabel: options.agent.name || options.agent.slug,
                },
            });
        },
    };
}

export { CONTEXT_MANAGEMENT_KEY };
