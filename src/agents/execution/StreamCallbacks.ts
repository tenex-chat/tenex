/**
 * StreamCallbacks - Callback factories for LLM streaming
 *
 * This module provides factory functions for creating the prepareStep and onStopCheck
 * callbacks used during LLM streaming execution.
 */

import { formatAnyError } from "@/lib/error-formatter";
import { LLMService } from "@/llm/service";
import { llmServiceFactory } from "@/llm/LLMServiceFactory";
import { config as configService } from "@/services/ConfigService";
import { RALRegistry, extractPendingDelegations } from "@/services/ral";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("tenex.stream-callbacks");
import type { LanguageModel, ModelMessage, StepResult } from "ai";
import { MessageCompiler } from "./MessageCompiler";
import { MessageSyncer } from "./MessageSyncer";
import type { FullRuntimeContext, RALExecutionContext } from "./types";

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
    llmService: { provider: string; updateUsageFromSteps: (steps: StepData["steps"]) => void };
    messageCompiler: MessageCompiler;
    ephemeralMessages: Array<{ role: "user" | "system"; content: string }>;
    nudgeContent: string;
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

/**
 * Create the prepareStep callback for message rebuilding and dynamic model switching
 */
export function createPrepareStep(
    config: PrepareStepConfig
): (step: StepData) => Promise<{ model?: LanguageModel; messages?: ModelMessage[] } | undefined> {
    const {
        context,
        llmService,
        messageCompiler,
        ephemeralMessages,
        nudgeContent,
        ralNumber,
        execContext,
        executionSpan,
        modelState,
    } = config;
    const conversationStore = context.conversationStore;
    const ralRegistry = RALRegistry.getInstance();
    const isMetaModel = configService.isMetaModelConfig(context.agent.llmConfig);

    // Import project context lazily to avoid circular dependencies
    const { getProjectContext } = require("@/services/projects");
    const projectContext = getProjectContext();
    const conversation = context.getConversation();

    return async (step: StepData) => {
        return tracer.startActiveSpan("tenex.agent.prepare_step", async (span) => {
            try {
                span.setAttribute("ral.number", ralNumber);
                span.setAttribute("agent.pubkey", context.agent.pubkey.substring(0, 8));
                span.setAttribute("conversation.id", context.conversationId.substring(0, 12));
                span.setAttribute("step.number", step.stepNumber);

                // Pass steps to LLM service for usage tracking
                llmService.updateUsageFromSteps(step.steps);

                // Update execution context with latest messages
                execContext.accumulatedMessages = step.messages;

                // Sync any tool calls/results from AI SDK to ConversationStore
                await tracer.startActiveSpan("tenex.agent.sync_messages", async (syncSpan) => {
                    try {
                        const syncer = new MessageSyncer(conversationStore, context.agent.pubkey, ralNumber);
                        syncer.syncFromSDK(step.messages);
                    } finally {
                        syncSpan.end();
                    }
                });

                // Process any new injections
                const newInjections = await tracer.startActiveSpan("tenex.agent.consume_injections", async (injectSpan) => {
                    try {
                        return ralRegistry.getAndConsumeInjections(
                            context.agent.pubkey,
                            context.conversationId,
                            ralNumber
                        );
                    } finally {
                        injectSpan.end();
                    }
                });

                const midStepEphemeralMessages: Array<{ role: "user" | "system"; content: string }> = [];

                if (newInjections.length > 0) {
                    for (const injection of newInjections) {
                        if (injection.ephemeral) {
                            midStepEphemeralMessages.push({
                                role: injection.role,
                                content: injection.content,
                            });
                        } else {
                            conversationStore.addMessage({
                                pubkey: context.triggeringEvent.pubkey,
                                ral: ralNumber,
                                content: injection.content,
                                messageType: "text",
                                targetedPubkeys: [context.agent.pubkey],
                                senderPubkey: injection.senderPubkey,
                                eventId: injection.eventId,
                            });
                        }
                    }

                    executionSpan?.addEvent("ral_injection.process", {
                        "injection.message_count": newInjections.length,
                        "injection.ephemeral_count": midStepEphemeralMessages.length,
                        "ral.number": ralNumber,
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

                const { messages: rebuiltMessages, mode } = await tracer.startActiveSpan("tenex.agent.compile_messages", async (compileSpan) => {
                    try {
                        const result = await messageCompiler.compile({
                            agent: context.agent,
                            project: projectContext.project,
                            conversation: conversation!,
                            projectBasePath: context.projectBasePath,
                            workingDirectory: context.workingDirectory,
                            currentBranch: context.currentBranch,
                            availableAgents: Array.from(projectContext.agents.values()),
                            mcpManager: projectContext.mcpManager,
                            agentLessons: projectContext.agentLessons,
                            nudgeContent,
                            respondingToPubkey: context.triggeringEvent.pubkey,
                            pendingDelegations,
                            completedDelegations,
                            ralNumber,
                            ephemeralMessages:
                                [...ephemeralMessages, ...midStepEphemeralMessages].length > 0
                                    ? [...ephemeralMessages, ...midStepEphemeralMessages]
                                    : undefined,
                        });
                        compileSpan.setAttribute("compilation.mode", result.mode);
                        compileSpan.setAttribute("compiled.message_count", result.messages.length);
                        return result;
                    } finally {
                        compileSpan.end();
                    }
                });

                span.setAttribute("compilation.mode", mode);
                span.setAttribute("compiled.message_count", rebuiltMessages.length);

                // For delta mode with no new messages, keep original
                if (mode === "delta" && rebuiltMessages.length === 0) {
                    logger.debug("[StreamCallbacks] prepareStep: delta mode with no new messages, keeping original");
                    return undefined;
                }

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
                                const newModel = LLMService.createLanguageModelFromRegistry(
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
                            }
                        }
                    }
                }

                return modelState.currentModel
                    ? { model: modelState.currentModel, messages: rebuiltMessages }
                    : { messages: rebuiltMessages };
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw error;
            } finally {
                span.end();
            }
        });
    };
}

/**
 * Configuration for creating the onStopCheck callback
 */
export interface OnStopCheckConfig {
    context: FullRuntimeContext;
    ralNumber: number;
    execContext: RALExecutionContext;
    executionSpan?: ReturnType<typeof trace.getActiveSpan>;
}

/**
 * Create the onStopCheck callback for delegation stop detection
 */
export function createOnStopCheck(
    config: OnStopCheckConfig
): (steps: StepResult<Record<string, AISdkTool>>[]) => Promise<boolean> {
    const { context, ralNumber, executionSpan } = config;
    const conversationStore = context.conversationStore;
    const ralRegistry = RALRegistry.getInstance();

    return async (steps: StepResult<Record<string, AISdkTool>>[]): Promise<boolean> => {
        if (steps.length === 0) return false;

        const lastStep = steps[steps.length - 1];
        const toolResults = lastStep.toolResults ?? [];

        for (const toolResult of toolResults) {
            const pendingDelegations = extractPendingDelegations(toolResult.output);
            if (pendingDelegations) {
                executionSpan?.addEvent("executor.delegation_stop", {
                    "ral.number": ralNumber,
                    "delegation.count": pendingDelegations.length,
                });

                // Use atomic merge to safely handle concurrent delegation calls
                ralRegistry.mergePendingDelegations(
                    context.agent.pubkey,
                    context.conversationId,
                    ralNumber,
                    pendingDelegations
                );

                conversationStore.save();

                ralRegistry.setStreaming(
                    context.agent.pubkey,
                    context.conversationId,
                    ralNumber,
                    false
                );

                return true;
            }
        }

        return false;
    };
}
