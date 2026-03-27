/**
 * StreamSetup - Handles pre-stream setup for LLM execution
 *
 * This module contains the setup logic that prepares everything needed
 * before streaming begins: tool wrapping, injection processing,
 * meta model resolution, and initial message compilation.
 */

import { config as configService } from "@/services/ConfigService";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { NudgeService, type NudgeToolPermissions, type NudgeData } from "@/services/nudge";
import { SkillService, type SkillData } from "@/services/skill";
import { getProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import { getToolsObject } from "@/tools/registry";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type { LLMService } from "@/llm/service";
import { MessageCompiler } from "./MessageCompiler";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { initializeReminderProviders, updateReminderData } from "./system-reminders";
import type { ToolExecutionTracker } from "./ToolExecutionTracker";
import { wrapToolsWithSupervision } from "./ToolSupervisionWrapper";
import {
    createExecutionContextManagement,
    type ExecutionContextManagement,
} from "./context-management";
import { prepareLLMRequest } from "./request-preparation";
import type { FullRuntimeContext, LLMModelRequest } from "./types";
import type { AISdkTool } from "@/tools/types";

/**
 * Result of stream setup
 */
export interface StreamSetupResult {
    toolsObject: Record<string, AISdkTool>;
    llmService: LLMService;
    messageCompiler: MessageCompiler;
    request: LLMModelRequest;
    contextManagement?: ExecutionContextManagement;
    nudgeContent: string;
    /** Individual nudge data for system prompt rendering */
    nudges: NudgeData[];
    /** Tool permissions extracted from nudge events */
    nudgeToolPermissions: NudgeToolPermissions;
    /** Concatenated skill content */
    skillContent: string;
    /** Individual skill data for system prompt rendering */
    skills: SkillData[];
    abortSignal: AbortSignal;
    metaModelSystemPrompt?: string;
    variantSystemPrompt?: string;
}

/**
 * Interface for injection processing
 */
export interface InjectionProcessor {
    warmSenderPubkeys(injections: Array<{ senderPubkey?: string }>): void;
}

/**
 * Set up everything needed for stream execution
 */
export async function setupStreamExecution(
    context: FullRuntimeContext,
    _toolTracker: ToolExecutionTracker, // Reserved for future use
    ralNumber: number,
    injectionProcessor: InjectionProcessor
): Promise<StreamSetupResult> {
    const triggeringPrincipalId =
        context.triggeringEnvelope.principal.linkedPubkey ?? context.triggeringEnvelope.principal.id;

    // === FETCH NUDGES FIRST ===
    // Must fetch nudges BEFORE getToolsObject because nudges can modify available tools
    const nudgeEventIds = context.triggeringEnvelope.metadata.nudgeEventIds ?? [];
    const nudgeResult = nudgeEventIds.length > 0
        ? await NudgeService.getInstance().fetchNudgesWithPermissions(nudgeEventIds)
        : { nudges: [], content: "", toolPermissions: {} };
    const projectContext = getProjectContext();
    const skillLookupContext = {
        agentPubkey: context.agent.pubkey,
        projectPath: context.projectBasePath || undefined,
        projectDTag: projectContext.project.dTag || projectContext.project.tagValue("d") || undefined,
    };

    // === FETCH SKILLS ===
    // Skills do NOT affect tools, but we fetch them early to download attached files
    // Merge delegation-provided skills, self-applied skills from conversation state,
    // and agent-level always-on skills from agent config
    const delegationSkillIds = context.triggeringEnvelope.metadata.skillEventIds ?? [];
    const selfAppliedSkillIds = context.conversationStore?.getSelfAppliedSkillIds(context.agent.pubkey) ?? [];
    const agentAlwaysSkillIds = context.agent.alwaysSkills ?? [];
    const requestedSkillIds = [...new Set([...delegationSkillIds, ...selfAppliedSkillIds, ...agentAlwaysSkillIds])];
    const skillResult = requestedSkillIds.length > 0
        ? await SkillService.getInstance().fetchSkills(requestedSkillIds, skillLookupContext)
        : { skills: [], content: "" };

    // Ensure MCP servers are started before resolving tools.
    // This is deferred from project boot to avoid spawning heavy child
    // processes (e.g. Chrome for chrome-devtools-mcp) until an agent
    // actually needs them.
    if ("mcpManager" in context && context.mcpManager) {
        await context.mcpManager.ensureReady();
    }

    // Now get tools with nudge permissions applied
    // IMPORTANT: Always call getToolsObject even with empty base tools,
    // because nudge permissions (allow-tool, only-tool) can grant tools
    // to agents that have no default tools configured.
    const toolNames = context.agent.tools || [];
    let toolsObject = getToolsObject(toolNames, context, nudgeResult.toolPermissions);

    const ralRegistry = RALRegistry.getInstance();
    const conversationStore = context.conversationStore;

    // Register RAL in ConversationStore
    conversationStore.ensureRalActive(context.agent.pubkey, ralNumber);

    // Consume any pending injections BEFORE building messages
    const initialInjections = ralRegistry.getAndConsumeInjections(
        context.agent.pubkey,
        context.conversationId,
        ralNumber
    );

    // Collect ephemeral messages to pass to MessageCompiler
    if (initialInjections.length > 0) {
        // Best-effort profile warming (non-blocking)
        injectionProcessor.warmSenderPubkeys(initialInjections);

        for (const injection of initialInjections) {
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

        trace.getActiveSpan()?.addEvent("executor.initial_injections_consumed", {
            "ral.number": ralNumber,
            "injection.count": initialInjections.length,
        });
    }

    const conversation = context.getConversation();
    if (!conversation) {
        throw new Error(`Conversation ${context.conversationId} not found`);
    }

    // Build MCP config from project's running MCP servers so agent providers can
    // spawn their own instances of external MCP servers when supported.
    const projectMcpServers = projectContext.mcpManager?.getServerConfigs() ?? {};
    const mcpConfig = Object.keys(projectMcpServers).length > 0
        ? { enabled: true, servers: projectMcpServers }
        : undefined;

    if (mcpConfig) {
        trace.getActiveSpan()?.addEvent("executor.mcp_config_prepared", {
            "mcp.server_count": Object.keys(projectMcpServers).length,
            "mcp.servers": Object.keys(projectMcpServers).join(", "),
        });
    }

    // Use already-fetched nudge content (fetched at the top of this function)
    const nudgeContent = nudgeResult.content;

    const abortSignal = llmOpsRegistry.registerOperation(context);

    // === META MODEL RESOLUTION ===
    let resolvedConfigName: string | undefined;
    let metaModelSystemPrompt: string | undefined;
    let variantSystemPrompt: string | undefined;

    if (configService.isMetaModelConfig(context.agent.llmConfig)) {
        const variantOverride = conversationStore.getMetaModelVariantOverride(context.agent.pubkey);
        const firstUserMessage = conversationStore.getFirstUserMessage();

        const resolution = configService.resolveMetaModel(
            context.agent.llmConfig,
            firstUserMessage?.content,
            variantOverride
        );

        if (resolution.isMetaModel) {
            resolvedConfigName = resolution.configName;
            metaModelSystemPrompt = resolution.metaModelSystemPrompt;
            variantSystemPrompt = resolution.variantSystemPrompt;

            if (
                !variantOverride &&
                resolution.strippedMessage !== undefined &&
                resolution.strippedMessage !== firstUserMessage?.content &&
                firstUserMessage
            ) {
                conversationStore.updateMessageContent(firstUserMessage.index, resolution.strippedMessage);
            }

            trace.getActiveSpan()?.addEvent("executor.meta_model_resolved", {
                "meta_model.original_config": context.agent.llmConfig,
                "meta_model.resolved_config": resolvedConfigName,
                "meta_model.variant": resolution.variantName || "default",
                "meta_model.used_override": !!variantOverride,
            });
        }
    }

    const llmService = context.agent.createLLMService({
        tools: toolsObject,
        workingDirectory: context.workingDirectory,
        conversationId: context.conversationId,
        resolvedConfigName,
        mcpConfig,
        onStreamStart: (injector) => {
            llmOpsRegistry.setMessageInjector(
                context.agent.pubkey,
                context.conversationId,
                injector
            );
            logger.debug("[StreamSetup] Message injector registered", {
                agent: context.agent.slug,
                conversationId: context.conversationId.substring(0, 8),
            });
        },
    });

    const contextManagement = createExecutionContextManagement({
        providerId: llmService.provider,
        conversationId: context.conversationId,
        agent: context.agent,
        conversationStore,
        nudgeToolPermissions: nudgeResult.toolPermissions,
    });

    if (contextManagement) {
        toolsObject = {
            ...toolsObject,
            ...contextManagement.optionalTools,
        };
    }

    toolsObject = wrapToolsWithSupervision(toolsObject, context);

    const messageCompiler = new MessageCompiler(conversationStore);

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

    const { messages, systemPrompt, counts } = await messageCompiler.compile({
        agent: context.agent,
        project: projectContext.project,
        conversation,
        triggeringEnvelope: context.triggeringEnvelope,
        projectBasePath: context.projectBasePath,
        workingDirectory: context.workingDirectory,
        currentBranch: context.currentBranch,
        availableAgents: Array.from(projectContext.agents.values()),
        mcpManager: projectContext.mcpManager,
        agentLessons: projectContext.agentLessons,
        agentComments: projectContext.agentComments,
        nudgeContent,
        nudges: nudgeResult.nudges,
        nudgeToolPermissions: nudgeResult.toolPermissions,
        skillContent: skillResult.content,
        skills: skillResult.skills,
        pendingDelegations,
        completedDelegations,
        ralNumber,
        metaModelSystemPrompt,
        variantSystemPrompt,
    });

    // Cache the compiled system prompt for reuse by supervision checks
    context.cachedSystemPrompt = systemPrompt;

    // Initialize providers (idempotent) and set data for this execution
    initializeReminderProviders();
    getSystemReminderContext().advance();
    updateReminderData({
        agent: context.agent,
        conversation,
        respondingToPrincipal: context.triggeringEnvelope.principal,
        pendingDelegations,
        completedDelegations,
    });

    trace.getActiveSpan()?.addEvent("executor.messages_built_from_store", {
        "ral.number": ralNumber,
        "message.count": counts.total,
        "system_prompt.count": counts.systemPrompt,
        "conversation.count": counts.conversation,
    });

    const request = await prepareLLMRequest({
        messages,
        tools: toolsObject,
        providerId: llmService.provider,
        model: {
            provider: llmService.provider,
            modelId: llmService.model,
        },
        contextManagement,
    });

    return {
        toolsObject,
        llmService,
        messageCompiler,
        request,
        contextManagement,
        nudgeContent,
        nudges: nudgeResult.nudges,
        nudgeToolPermissions: nudgeResult.toolPermissions,
        skillContent: skillResult.content,
        skills: skillResult.skills,
        abortSignal,
        metaModelSystemPrompt,
        variantSystemPrompt,
    };
}
