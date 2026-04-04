import { trace } from "@opentelemetry/api";
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import {
    AnthropicPromptCachingStrategy,
    buildDeterministicSummary,
    buildSummaryTranscript,
    CompactionToolStrategy,
    CONTEXT_MANAGEMENT_KEY,
    type CompactionStore,
    type CompactionToolStrategyOptions,
    type ContextManagementPreparedRequest,
    ScratchpadStrategy,
    RemindersStrategy,
    ToolResultDecayStrategy,
    createContextManagementRuntime,
    createDefaultPromptTokenEstimator,
    type PrepareContextManagementRequestOptions,
    type ContextManagementRequestContext,
    type ContextManagementRuntime,
    type ContextManagementStrategy,
    type DecayedToolContext,
    type RemindersStrategyOptions,
} from "ai-sdk-context-management";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import { getContextWindow } from "@/llm/utils/context-window-cache";
import { config as configService } from "@/services/ConfigService";
import { isOnlyToolMode, type SkillToolPermissions } from "@/services/skill";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import type { AISdkTool } from "@/tools/types";
import { shortenConversationId } from "@/utils/conversation-id";
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
    createTenexReminderProviders,
    createTenexReminderStateStore,
    type TenexReminderData,
} from "../system-reminders";
import {
    fromRuntimeScratchpadState,
    toRuntimeScratchpadConversationEntries,
    toRuntimeScratchpadState,
} from "./scratchpad-store";
import { createTelemetryCallback } from "./telemetry";

export interface ExecutionContextManagement {
    optionalTools: Record<string, AISdkTool>;
    requestContext: ContextManagementRequestContext;
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
            "context_management.compaction_model_unavailable",
            {
                "context_management.conversation_id": options.conversationId,
                "context_management.agent_id": options.agent.pubkey,
            }
        );
        return undefined;
    }
}

const COMPACTION_SUMMARIZER_SYSTEM_PROMPT = [
    "Compress prior TENEX execution context into a high-signal continuation summary for future work.",
    "Return plain text with exactly these sections and headings: Task, Completed, Important Findings, Failures And Dead Ends, Tool Use And Side Effects, Open Issues, Next Steps, Persistent Facts.",
    "Preserve the current user goal, constraints, decisions, exact file paths, commands, URLs, identifiers, tool names, relevant tool-call IDs, side effects, failures, retries, dead ends, plans, unfinished work, and facts needed to continue safely.",
    "Keep concrete artifacts over vague gist. Mention what changed, what was tried, what did not work, and what remains.",
    "Do not invent progress, verification, or results. Do not hide unresolved risk. Do not claim tests passed unless the transcript proves it.",
    "Summarize only from the provided transcript and steering note.",
].join(" ");

function wrapCompactionSummary(summary: string, conversationId: string): string {
    return [
        `Continuation from previous work in conversation ${conversationId}.`,
        `If more detail is needed, query the full prior transcript with \`conversation_get ${shortenConversationId(conversationId)}\`.`,
        "",
        summary.trim(),
    ].join("\n");
}

function createCompactionStore(options: {
    conversationStore: ConversationStore;
}): CompactionStore {
    return {
        get: ({ agentId }) => {
            return options.conversationStore.getContextManagementCompaction(agentId);
        },
        set: async ({ agentId }, state) => {
            const existing = options.conversationStore.getContextManagementCompaction(agentId);
            options.conversationStore.setContextManagementCompaction(agentId, {
                ...state,
                ...(state.agentLabel ? {} : existing?.agentLabel ? { agentLabel: existing.agentLabel } : {}),
            });
            await options.conversationStore.save();
        },
    };
}

function createCompactionCallback(
    model: LanguageModel,
    conversationId: string
): NonNullable<CompactionToolStrategyOptions["onCompact"]> {
    return async ({ messages, mode, steeringMessage }) => {
        const transcript = buildSummaryTranscript(messages);
        const deterministicFallback = wrapCompactionSummary(
            buildDeterministicSummary(messages),
            conversationId
        );
        const steeringBlock = steeringMessage
            ? `\n\nCompaction emphasis from current model:\n${steeringMessage.trim()}`
            : "";
        const summaryPrompt: ModelMessage[] = [
            {
                role: "system",
                content: COMPACTION_SUMMARIZER_SYSTEM_PROMPT,
            },
            {
                role: "user",
                content: [
                    `Compaction mode: ${mode}.`,
                    "Summarize this TENEX execution transcript so work can continue safely after context compaction.",
                    "Capture goals, important completed work, findings, failed attempts, tool use, side effects, open issues, next steps, and persistent facts.",
                    steeringBlock ? steeringBlock.trim() : "",
                    "",
                    "Transcript to compact:",
                    transcript,
                ].filter((line) => line.length > 0).join("\n"),
            },
        ];

        try {
            const { text } = await generateText({
                model,
                messages: summaryPrompt,
                temperature: 0,
                maxOutputTokens: 1400,
            });
            const summary = text.trim();
            return summary.length > 0
                ? wrapCompactionSummary(summary, conversationId)
                : deterministicFallback;
        } catch {
            return deterministicFallback;
        }
    };
}

function createConversationContextManagementRuntime(options: {
    providerId: string;
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

    const strategies: ContextManagementStrategy[] = [];

    if (scratchpadEnabled && settings.strategies.scratchpad) {
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

    const summarizationModel = createSummarizationModel({
        conversationId: options.conversationId,
        agent: options.agent,
    });

    if (settings.strategies.compaction) {
        const compactionOptions: CompactionToolStrategyOptions = {
            compactionStore: createCompactionStore({
                conversationStore: options.conversationStore,
            }),
        };

        if (summarizationModel) {
            compactionOptions.shouldCompact = ({ prompt }) => {
                const currentTokens = managedBudgetProfile.estimator.estimatePrompt(prompt);
                const thresholdTokens =
                    managedBudgetProfile.tokenBudget
                    * (settings.compactionThresholdPercent / 100);
                return currentTokens >= thresholdTokens;
            };
            compactionOptions.onCompact = createCompactionCallback(
                summarizationModel,
                options.conversationId
            );
        }

        strategies.push(
            new CompactionToolStrategy(compactionOptions)
        );
    }

    if (settings.strategies.toolResultDecay) {
        strategies.push(
            new ToolResultDecayStrategy({
                estimator: managedBudgetProfile.estimator,
                placeholder: ({ toolName, toolCallId }: DecayedToolContext) => {
                    return buildDecayPlaceholder(toolName, toolCallId);
                },
            })
        );
    }

    if (settings.strategies.reminders) {
        const reminderOptions: RemindersStrategyOptions<TenexReminderData> = {};

        reminderOptions.stateStore = createTenexReminderStateStore({
            conversationStore: options.conversationStore,
        });
        reminderOptions.providers = createTenexReminderProviders();
        reminderOptions.overlayType = "system-reminders";
        reminderOptions.contextUtilization = settings.strategies.contextUtilizationReminder
            ? {
                budgetProfile: managedBudgetProfile,
                warningThresholdRatio: settings.utilizationWarningThresholdPercent / 100,
                mode: scratchpadEnabled ? "scratchpad" : "generic",
            }
            : false;

        reminderOptions.contextWindowStatus = settings.strategies.contextWindowStatus
            ? {
                getContextWindow: ({ model }) => {
                    if (!model) {
                        return undefined;
                    }

                    return getContextWindow(
                        normalizeProviderId(model.provider),
                        model.modelId
                    );
                },
            }
            : false;

        strategies.push(new RemindersStrategy<TenexReminderData>(reminderOptions));
    }

    if (settings.strategies.anthropicPromptCaching) {
        strategies.push(new AnthropicPromptCachingStrategy({
            ttl: settings.anthropicPromptCaching.ttl,
            serverToolEditing: false,
        }));
    }

    const telemetry = createTelemetryCallback();
    const runtime = createContextManagementRuntime({
        strategies,
        telemetry,
        estimator: requestEstimator,
    });
    return {
        runtime,
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
        return {
            optionalTools: {},
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

    const { runtime } = createConversationContextManagementRuntime({
        providerId: options.providerId,
        conversationStore: options.conversationStore,
        conversationId: options.conversationId,
        agent: options.agent,
        scratchpadAvailable,
    });
    const optionalTools = runtime.optionalTools as unknown as Record<string, AISdkTool>;

    return {
        optionalTools,
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
