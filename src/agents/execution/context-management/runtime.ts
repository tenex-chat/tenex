import { trace } from "@opentelemetry/api";
import type { LanguageModel } from "ai";
import {
    CONTEXT_MANAGEMENT_KEY,
    ContextUtilizationReminderStrategy,
    ContextWindowStatusStrategy,
    createSharedPrefixTracker,
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
    type SharedPrefixTracker,
} from "ai-sdk-context-management";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { PROVIDER_IDS } from "@/llm/providers/provider-ids";
import { getContextWindow } from "@/llm/utils/context-window-cache";
import { config as configService } from "@/services/ConfigService";
import { isOnlyToolMode, type SkillToolPermissions } from "@/services/skill";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import type { AISdkTool } from "@/tools/types";
import {
    buildDecayPlaceholder,
    createManagedContextBudgetProfile,
    normalizeProviderId,
} from "./budget-profile";
import { normalizeMessagesForContextManagement } from "./normalize-messages";
import {
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
    promptStabilityTracker?: SharedPrefixTracker;
    scratchpadAvailable: boolean;
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
        const projectContext = isProjectContextInitialized()
            ? getProjectContext()
            : undefined;
        const llmService = configService.createLLMService(configName, {
            agentName: "context-summarizer",
            agentSlug: "context-summarizer",
            conversationId: options.conversationId,
            projectId: projectContext?.project.dTag ?? projectContext?.project.tagValue("d"),
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
    providerId: string;
    conversationStore: ConversationStore;
    conversationId: string;
    agent: AgentInstance;
    scratchpadAvailable: boolean;
}): {
    runtime: ContextManagementRuntime;
    promptStabilityTracker: SharedPrefixTracker;
} {
    const settings = getContextManagementSettings();
    const requestEstimator = createDefaultPromptTokenEstimator();
    const managedBudgetProfile = createManagedContextBudgetProfile(
        settings.tokenBudget,
        requestEstimator
    );
    const isAnthropicProvider = options.providerId === PROVIDER_IDS.ANTHROPIC;
    const scratchpadEnabled = options.scratchpadAvailable && !isAnthropicProvider;

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

    if (!isAnthropicProvider) {
        strategies.push(
            new ToolResultDecayStrategy({
                estimator: managedBudgetProfile.estimator,
                placeholder: ({ toolName, toolCallId }: DecayedToolContext) => {
                    return buildDecayPlaceholder(toolName, toolCallId);
                },
            })
        );
    }

    const summarizationModel = createSummarizationModel({
        conversationId: options.conversationId,
        agent: options.agent,
    });

    if (summarizationModel && !isAnthropicProvider) {
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
    return {
        runtime,
        promptStabilityTracker: createSharedPrefixTracker(),
    };
}

export function createExecutionContextManagement(options: {
    providerId: string;
    conversationId: string;
    agent: AgentInstance;
    conversationStore: ConversationStore;
    skillToolPermissions?: SkillToolPermissions;
}): ExecutionContextManagement | undefined {
    const settings = getContextManagementSettings();

    const requestContext: ContextManagementRequestContext = {
        conversationId: options.conversationId,
        agentId: options.agent.pubkey,
        agentLabel: options.agent.name || options.agent.slug,
    };

    if (!settings.enabled) {
        // Strategies are disabled, but return a minimal object so Anthropic-specific
        // prompt caching and clear-tool-uses logic in request-preparation.ts still runs.
        return {
            optionalTools: {},
            promptStabilityTracker: createSharedPrefixTracker(),
            requestContext,
            scratchpadAvailable: true,
            async prepareRequest(requestOptions) {
                return {
                    messages: normalizeMessagesForContextManagement(requestOptions.messages),
                    providerOptions: requestOptions.providerOptions,
                    toolChoice: requestOptions.toolChoice,
                    reportActualUsage: async () => {},
                };
            },
        };
    }

    const scratchpadAvailable =
        !options.skillToolPermissions || !isOnlyToolMode(options.skillToolPermissions);

    const { runtime, promptStabilityTracker } = createConversationContextManagementRuntime({
        providerId: options.providerId,
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
        promptStabilityTracker,
        requestContext,
        scratchpadAvailable,
        async prepareRequest(requestOptions) {
            return await runtime.prepareRequest({
                ...requestOptions,
                messages: normalizeMessagesForContextManagement(
                    requestOptions.messages
                ),
                requestContext,
            });
        },
    };
}

export { CONTEXT_MANAGEMENT_KEY };
