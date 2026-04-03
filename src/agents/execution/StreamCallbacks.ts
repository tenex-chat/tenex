/**
 * StreamCallbacks - Callback factories for LLM streaming
 *
 * This module provides factory functions for creating the prepareStep and onStopCheck
 * callbacks used during LLM streaming execution.
 */

import { formatAnyError } from "@/lib/error-formatter";
import { llmServiceFactory } from "@/llm/LLMServiceFactory";
import { config as configService } from "@/services/ConfigService";
import { createViolationReminders } from "@/services/heuristics";
import { RALRegistry } from "@/services/ral";
import { SkillService, loadAllSkillTools } from "@/services/skill";
import type { SkillData, SkillToolPermissions } from "@/services/skill";
import { HOME_FS_FALLBACKS } from "@/tools/registry";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type {
    LanguageModel,
    ModelMessage,
    ProviderRegistryProvider,
    Tool as CoreTool,
    ToolChoice,
} from "ai";
import type { SharedV3ProviderOptions as ProviderOptions } from "@ai-sdk/provider";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import type { AISdkTool } from "@/tools/types";
import type { ExecutionContextManagement } from "./context-management";
import type { MessageCompiler } from "./MessageCompiler";
import { MessageSyncer } from "./MessageSyncer";
import { prepareLLMRequest } from "./request-preparation";
import { createProjectDTag } from "@/types/project-ids";
import type { FullRuntimeContext, LLMModelRequest, RALExecutionContext } from "./types";
import { buildPromptHistoryMessages } from "./prompt-history";

/**
 * Step data passed to prepareStep callback
 */
export interface StepData {
    messages: ModelMessage[];
    stepNumber: number;
    steps: Array<{
        toolCalls: Array<{ toolName: string }>;
        text: string;
        reasoningText?: string;
        usage?: { inputTokens?: number; outputTokens?: number };
        providerMetadata?: {
            openrouter?: {
                usage?: {
                    promptTokens?: number;
                    completionTokens?: number;
                    totalTokens?: number;
                    cost?: number;
                    promptTokensDetails?: { cachedTokens?: number };
                    completionTokensDetails?: { reasoningTokens?: number };
                };
            };
        };
    }>;
}

/**
 * Configuration for creating the prepareStep callback
 */
export interface PrepareStepConfig {
    context: FullRuntimeContext;
    llmService: {
        provider: string;
        model: string;
        updateUsageFromSteps: (steps: StepData["steps"]) => void;
        createLanguageModelFromRegistry: (
            provider: string,
            model: string,
            registry: ProviderRegistryProvider
        ) => LanguageModel;
    };
    messageCompiler: MessageCompiler;
    toolsObject: Record<string, AISdkTool>;
    contextManagement?: ExecutionContextManagement;
    initialRequest: LLMModelRequest;
    /** Tool permissions extracted from skill events */
    skillToolPermissions: SkillToolPermissions;
    ralNumber: number;
    execContext: RALExecutionContext;
    executionSpan?: ReturnType<typeof trace.getActiveSpan>;
    modelState: {
        lastUsedVariant: string | undefined;
        currentModel: LanguageModel | undefined;
        setVariant: (variant: string | undefined) => void;
        setModel: (model: LanguageModel | undefined) => void;
    };
}

type PreparedStepResult = {
    model?: LanguageModel;
    messages?: ModelMessage[];
    providerOptions?: ProviderOptions;
    experimental_context?: unknown;
    toolChoice?: ToolChoice<Record<string, CoreTool>>;
    analysisRequestSeed?: LLMModelRequest["analysisRequestSeed"];
};

type PreparedStepCacheEntry = {
    model?: LanguageModel;
    request: LLMModelRequest;
};

function resolvePreparedModelRef(options: {
    model: LanguageModel | undefined;
    fallbackProvider: string;
    fallbackModelId: string;
}): { provider: string; modelId: string } {
    const { model, fallbackProvider, fallbackModelId } = options;

    if (
        model &&
        typeof model !== "string" &&
        "provider" in model &&
        typeof model.provider === "string" &&
        "modelId" in model &&
        typeof model.modelId === "string"
    ) {
        return {
            provider: model.provider,
            modelId: model.modelId,
        };
    }

    return {
        provider: fallbackProvider,
        modelId: fallbackModelId,
    };
}

/**
 * Create the prepareStep callback for message rebuilding and dynamic model switching
 */
export function createPrepareStep(
    config: PrepareStepConfig
): (step: StepData) => Promise<PreparedStepResult | undefined> {
    const {
        context,
        llmService,
        messageCompiler,
        toolsObject,
        contextManagement,
        initialRequest,
        skillToolPermissions,
        ralNumber,
        execContext,
        executionSpan,
        modelState,
    } = config;
    const conversationStore = context.conversationStore;
    const ralRegistry = RALRegistry.getInstance();
    const isMetaModel = configService.isMetaModelConfig(context.agent.llmConfig);
    const preparedStepCache = new Map<number, PreparedStepCacheEntry>();

    preparedStepCache.set(0, { request: initialRequest });

    // Import project context lazily to avoid circular dependencies
    let projectContextModulePromise: Promise<typeof import("@/services/projects")> | null = null;
    const loadProjectContextModule = async (): Promise<typeof import("@/services/projects")> => {
        if (!projectContextModulePromise) {
            projectContextModulePromise = import("@/services/projects");
        }
        return projectContextModulePromise;
    };

    return async (step: StepData) => {
        const { getProjectContext } = await loadProjectContextModule();
        const projectContext = getProjectContext();
        const skillLookupContext = {
            agentPubkey: context.agent.pubkey,
            projectPath: context.projectBasePath || undefined,
            projectDTag: projectContext.project.dTag || projectContext.project.tagValue("d") || undefined,
        };
        const conversation = context.getConversation();
        if (!conversation) {
            throw new Error("Conversation store unavailable during prepareStep");
        }

        try {
            const lastCompletedStep = step.steps.at(-1);
            if (lastCompletedStep && execContext.pendingContextManagementUsageReporter) {
                await execContext.pendingContextManagementUsageReporter(
                    lastCompletedStep.usage?.inputTokens
                );
                execContext.pendingContextManagementUsageReporter = undefined;
            }

            // Pass steps to LLM service for usage tracking
            llmService.updateUsageFromSteps(step.steps);

            const cachedPreparedStep = preparedStepCache.get(step.stepNumber);
            if (cachedPreparedStep) {
                execContext.accumulatedMessages = cachedPreparedStep.request.messages;
                execContext.pendingContextManagementUsageReporter =
                    cachedPreparedStep.request.reportContextManagementUsage;

                return {
                    model: cachedPreparedStep.model,
                    messages: cachedPreparedStep.request.messages,
                    providerOptions: cachedPreparedStep.request.providerOptions,
                    experimental_context: cachedPreparedStep.request.experimentalContext,
                    toolChoice: cachedPreparedStep.request.toolChoice ?? ("auto" as const),
                    analysisRequestSeed: cachedPreparedStep.request.analysisRequestSeed,
                };
            }

            // Update execution context with latest messages
            execContext.accumulatedMessages = step.messages;

            // Sync any tool calls/results from AI SDK to ConversationStore
            const syncer = new MessageSyncer(conversationStore, context.agent.pubkey, ralNumber);
            syncer.syncFromSDK(step.messages);

            // Process any new injections before recompiling messages
            const newInjections = ralRegistry.getAndConsumeInjections(
                context.agent.pubkey,
                context.conversationId,
                ralNumber
            );

            if (newInjections.length > 0) {
                const triggeringPrincipalId =
                    context.triggeringEnvelope.principal.linkedPubkey ??
                    context.triggeringEnvelope.principal.id;
                for (const injection of newInjections) {
                    const relocated = injection.eventId
                        ? conversationStore.relocateToEnd(injection.eventId, {
                              ral: ralNumber,
                              senderPubkey: injection.senderPubkey,
                              senderPrincipal: injection.senderPrincipal,
                              targetedPubkeys: [context.agent.pubkey],
                              targetedPrincipals: injection.targetedPrincipals,
                          })
                        : false;

                    if (!relocated) {
                        conversationStore.addMessage({
                            pubkey: triggeringPrincipalId,
                            ral: ralNumber,
                            content: injection.content,
                            messageType: "text",
                            targetedPubkeys: [context.agent.pubkey],
                            targetedPrincipals: injection.targetedPrincipals,
                            senderPubkey: injection.senderPubkey,
                            senderPrincipal: injection.senderPrincipal,
                            eventId: injection.eventId,
                        });
                    }
                }

                executionSpan?.addEvent("ral_injection.process", {
                    "injection.message_count": newInjections.length,
                    "ral.number": ralNumber,
                });
            }

            // === HEURISTIC VIOLATIONS INJECTION ===
            const heuristicViolations = ralRegistry.getAndConsumeHeuristicViolations(
                context.agent.pubkey,
                context.conversationId,
                ralNumber
            );

            if (heuristicViolations.length > 0) {
                const reminders = createViolationReminders(heuristicViolations);

                for (const reminder of reminders) {
                    getSystemReminderContext().queue(reminder);
                }

                executionSpan?.addEvent("heuristic.violations_injected", {
                    "ral.number": ralNumber,
                    "violation.count": heuristicViolations.length,
                    "violation.ids": heuristicViolations.map((v) => v.id).join(","),
                });

                logger.info("[StreamCallbacks] Injected heuristic violations", {
                    agent: context.agent.slug,
                    ralNumber,
                    violationCount: heuristicViolations.length,
                });
            }

            const pendingDelegations = ralRegistry.getConversationPendingDelegations(
                context.agent.pubkey,
                context.conversationId,
                ralNumber
            );
            const completedDelegations = ralRegistry.getConversationCompletedDelegations(
                context.agent.pubkey,
                context.conversationId,
                ralNumber
            );

            // Rehydrate skills from ConversationStore to pick up mid-RAL self-applied changes
            const delegationSkillIds = context.triggeringEnvelope.metadata.skillEventIds ?? [];
            const selfAppliedSkillIds = conversationStore?.getSelfAppliedSkillIds(context.agent.pubkey) ?? [];
            const agentAlwaysSkillIds = context.agent.alwaysSkills ?? [];
            const requestedSkillIds = [...new Set([
                ...delegationSkillIds,
                ...selfAppliedSkillIds,
                ...agentAlwaysSkillIds,
            ])];
            const currentSkillResult = requestedSkillIds.length > 0
                ? await SkillService.getInstance().fetchSkills(requestedSkillIds, skillLookupContext)
                : { skills: [] as SkillData[], content: "" };

            // Inject any new skill-declared tools into the mutable toolsObject
            // so the AI SDK picks them up in this step (object is passed by reference)
            if (currentSkillResult.skills.length > 0 && !skillToolPermissions?.onlyTools) {
                const skillTools = await loadAllSkillTools(currentSkillResult.skills, context);
                if (Object.keys(skillTools).length > 0) {
                    const denyTools = skillToolPermissions?.denyTools ?? [];
                    for (const denied of denyTools) {
                        delete skillTools[denied];
                    }
                    // Only add tools not already present
                    for (const [name, toolDef] of Object.entries(skillTools)) {
                        if (!(name in toolsObject)) {
                            toolsObject[name] = toolDef;
                            logger.info("[StreamCallbacks] Injected skill tool mid-execution", {
                                agent: context.agent.slug,
                                tool: name,
                                stepNumber: step.stepNumber,
                            });
                        }
                    }

                    // Remove home_fs_* fallbacks if their fs_* counterparts are now available
                    for (const [fsTool, homeFallbacks] of HOME_FS_FALLBACKS) {
                        if (fsTool in toolsObject) {
                            for (const fallback of homeFallbacks) {
                                delete toolsObject[fallback];
                            }
                        }
                    }
                }
            }

            const compiled = await messageCompiler.compile({
                agent: context.agent,
                project: projectContext.project,
                conversation,
                triggeringEnvelope: context.triggeringEnvelope,
                projectBasePath: context.projectBasePath,
                workingDirectory: context.workingDirectory,
                currentBranch: context.currentBranch,
                availableAgents: Array.from(projectContext.agents.values()),
                pendingDelegations,
                completedDelegations,
                ralNumber,
            });

            const rawDTag = projectContext.project.dTag || projectContext.project.tagValue("d");
            const dTag = rawDTag ? createProjectDTag(rawDTag) : undefined;
            const reminderData = {
                agent: context.agent,
                conversation,
                respondingToPrincipal: context.triggeringEnvelope.principal,
                pendingDelegations,
                completedDelegations,
                projectId: dTag,
                loadedSkills: currentSkillResult.skills,
                skillToolPermissions,
                projectPath: context.projectBasePath || undefined,
            };
            const promptHistoryResult = buildPromptHistoryMessages({
                compiled,
                conversationStore: conversation,
                agentPubkey: context.agent.pubkey,
                span: executionSpan,
            });
            const rebuiltMessages = promptHistoryResult.messages;

            // Dynamic model switching
            if (isMetaModel) {
                const currentVariant = conversationStore.getMetaModelVariantOverride(context.agent.pubkey);

                if (currentVariant !== modelState.lastUsedVariant) {
                    const resolution = configService.resolveMetaModel(
                        context.agent.llmConfig,
                        undefined,
                        currentVariant
                    );

                    if (resolution.isMetaModel) {
                        const newLlmConfig = configService.getLLMConfig(resolution.configName);

                        try {
                            const registry = llmServiceFactory.getRegistry();
                            const newModel = llmService.createLanguageModelFromRegistry(
                                newLlmConfig.provider,
                                newLlmConfig.model,
                                registry
                            );

                            const previousVariant = modelState.lastUsedVariant;

                            executionSpan?.addEvent("executor.model_switched", {
                                "ral.number": ralNumber,
                                "meta_model.previous_variant": previousVariant || "default",
                                "meta_model.new_variant": currentVariant || "default",
                                "meta_model.new_config": resolution.configName,
                                "meta_model.new_provider": newLlmConfig.provider,
                                "meta_model.new_model": newLlmConfig.model,
                            });

                            logger.info("[StreamCallbacks] Dynamic model switch via change_model tool", {
                                agent: context.agent.slug,
                                previousVariant: previousVariant || "default",
                                newVariant: currentVariant || "default",
                                newConfig: resolution.configName,
                            });

                            modelState.setVariant(currentVariant);
                            modelState.setModel(newModel);
                        } catch (modelError) {
                            logger.error("[StreamCallbacks] Failed to create new model for variant switch", {
                                error: formatAnyError(modelError),
                                variant: currentVariant,
                                config: resolution.configName,
                            });
                            logger.writeToWarnLog({
                                timestamp: new Date().toISOString(),
                                level: "error",
                                component: "StreamCallbacks",
                                message: "Failed to create new model for variant switch",
                                context: {
                                    agent: context.agent.slug,
                                    variant: currentVariant,
                                    config: resolution.configName,
                                },
                                error: formatAnyError(modelError),
                                stack: modelError instanceof Error ? modelError.stack : undefined,
                            });
                        }
                    }
                }
            }

            const preparedModel = modelState.currentModel;
            const preparedModelRef = resolvePreparedModelRef({
                model: preparedModel,
                fallbackProvider: llmService.provider,
                fallbackModelId: llmService.model,
            });
            const reminderStateBefore = JSON.stringify(
                conversation.getContextManagementReminderState(context.agent.pubkey) ?? null
            );
            const preparedRequest = await prepareLLMRequest({
                messages: rebuiltMessages,
                tools: toolsObject,
                providerId: preparedModelRef.provider,
                model: preparedModelRef,
                contextManagement,
                reminderData,
                analysisContext: {
                    projectId:
                        projectContext.project.dTag
                        || projectContext.project.tagValue("d")
                        || undefined,
                    conversationId: context.conversationId,
                    agentSlug: context.agent.slug,
                    agentId: context.agent.pubkey,
                },
            });
            const reminderStateAfter = JSON.stringify(
                conversation.getContextManagementReminderState(context.agent.pubkey) ?? null
            );
            const reminderStateChanged = reminderStateBefore !== reminderStateAfter;
            const overlayHistoryResult = preparedRequest.runtimeOverlays?.length
                ? buildPromptHistoryMessages({
                    compiled,
                    conversationStore: conversation,
                    agentPubkey: context.agent.pubkey,
                    runtimeOverlays: preparedRequest.runtimeOverlays,
                    reminderStateChanged,
                    span: executionSpan,
                })
                : undefined;

            if (
                promptHistoryResult.didMutateHistory
                || overlayHistoryResult?.didMutateHistory
                || reminderStateChanged
            ) {
                await conversation.save();
            }

            execContext.accumulatedMessages = preparedRequest.messages;
            execContext.pendingContextManagementUsageReporter =
                preparedRequest.reportContextManagementUsage;

            preparedStepCache.set(step.stepNumber, {
                model: preparedModel,
                request: preparedRequest,
            });

            return {
                ...(preparedModel ? { model: preparedModel } : {}),
                messages: preparedRequest.messages,
                providerOptions: preparedRequest.providerOptions,
                experimental_context: preparedRequest.experimentalContext,
                toolChoice: preparedRequest.toolChoice ?? ("auto" as const),
                analysisRequestSeed: preparedRequest.analysisRequestSeed,
            };
        } catch (error) {
            logger.writeToWarnLog({
                timestamp: new Date().toISOString(),
                level: "error",
                component: "StreamCallbacks",
                message: "LLM streaming prepareStep failed",
                context: {
                    agent: context.agent.slug,
                    conversationId: context.conversationId,
                    stepNumber: step.stepNumber,
                    ralNumber,
                },
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
            throw error;
        }
    };
}
