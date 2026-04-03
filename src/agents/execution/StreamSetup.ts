/**
 * StreamSetup - Handles pre-stream setup for LLM execution
 *
 * This module contains the setup logic that prepares everything needed
 * before streaming begins: tool wrapping, injection processing,
 * meta model resolution, and initial message compilation.
 */

import { config as configService } from "@/services/ConfigService";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { SkillService, type SkillToolPermissions, loadAllSkillTools } from "@/services/skill";
import { getProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import { getToolsObject, HOME_FS_FALLBACKS } from "@/tools/registry";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type { LLMService } from "@/llm/service";
import { MessageCompiler } from "./MessageCompiler";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { initializeReminderProviders, updateReminderData, collectSystemReminderOverlayMessage } from "./system-reminders";
import { renderConversationsReminder } from "@/prompts/reminders/conversations";
import type { ToolExecutionTracker } from "./ToolExecutionTracker";
import { wrapToolsWithSupervision } from "./ToolSupervisionWrapper";
import { FullResultStash, wrapToolsWithOutputTruncation } from "./ToolOutputTruncation";
import {
    createExecutionContextManagement,
    type ExecutionContextManagement,
} from "./context-management";
import { buildPromptHistoryMessages } from "./prompt-history";
import { prepareLLMRequest } from "./request-preparation";
import type { FullRuntimeContext, LLMModelRequest } from "./types";
import type { AISdkTool } from "@/tools/types";
import { createProjectDTag } from "@/types/project-ids";

/**
 * Result of stream setup
 */
export interface StreamSetupResult {
    toolsObject: Record<string, AISdkTool>;
    llmService: LLMService;
    messageCompiler: MessageCompiler;
    request: LLMModelRequest;
    contextManagement?: ExecutionContextManagement;
    /** Tool permissions aggregated across all active skills (needed for tool permission enforcement) */
    skillToolPermissions: SkillToolPermissions;
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
    toolTracker: ToolExecutionTracker,
    ralNumber: number,
    injectionProcessor: InjectionProcessor
): Promise<StreamSetupResult> {
    const triggeringPrincipalId =
        context.triggeringEnvelope.principal.linkedPubkey ?? context.triggeringEnvelope.principal.id;

    const projectContext = getProjectContext();
    const skillLookupContext = {
        agentPubkey: context.agent.pubkey,
        projectPath: context.projectBasePath || undefined,
        projectDTag: projectContext.project.dTag || projectContext.project.tagValue("d") || undefined,
    };

    // === FETCH SKILLS ===
    // Must fetch skills BEFORE getToolsObject because skills can modify available tools
    // Merge delegation-provided skills, self-applied skills from conversation state,
    // and agent-level always-on skills from agent config
    const delegationSkillIds = context.triggeringEnvelope.metadata.skillEventIds ?? [];
    const selfAppliedSkillIds = context.conversationStore?.getSelfAppliedSkillIds(context.agent.pubkey) ?? [];
    const agentAlwaysSkillIds = context.agent.alwaysSkills ?? [];
    const requestedSkillIds = [...new Set([...delegationSkillIds, ...selfAppliedSkillIds, ...agentAlwaysSkillIds])];
    const skillResult = requestedSkillIds.length > 0
        ? await SkillService.getInstance().fetchSkills(requestedSkillIds, skillLookupContext)
        : { skills: [], content: "", toolPermissions: {} };

    // Start MCP servers the agent has access to via mcpAccess.
    // MCP startup is expensive (e.g. chrome-devtools-mcp launches a browser, ~6GB RSS).
    const mcpServerSlugs = context.agent.mcpAccess ?? [];
    if (mcpServerSlugs.length > 0 && "mcpManager" in context && context.mcpManager) {
        await context.mcpManager.ensureServersForSlugs(mcpServerSlugs);
    }
    let toolsObject = getToolsObject(context.agent.tools || [], context, skillResult.toolPermissions);

    // === LOAD SKILL-DECLARED TOOLS ===
    // Skills can declare tools in their SKILL.md frontmatter.
    // Load and merge them into toolsObject, respecting deny-tool permissions.
    if (skillResult.skills.length > 0 && !skillResult.toolPermissions?.onlyTools) {
        const skillTools = await loadAllSkillTools(skillResult.skills, context);
        if (Object.keys(skillTools).length > 0) {
            // Apply deny-tool filtering to skill-injected tools
            const denyTools = skillResult.toolPermissions?.denyTools ?? [];
            for (const denied of denyTools) {
                delete skillTools[denied];
            }
            // Merge skill tools into final toolsObject
            Object.assign(toolsObject, skillTools);

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
        skillToolPermissions: skillResult.toolPermissions,
    });

    if (contextManagement) {
        toolsObject = {
            ...toolsObject,
            ...contextManagement.optionalTools,
        };
    }

    const fullResultStash = new FullResultStash();
    toolTracker.setFullResultStash(fullResultStash);
    toolsObject = wrapToolsWithOutputTruncation(toolsObject, fullResultStash);
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
        metaModelSystemPrompt,
        variantSystemPrompt,
        scratchpadAvailable: contextManagement?.scratchpadAvailable ?? true,
    });

    // Cache the compiled system prompt for reuse by supervision checks
    context.cachedSystemPrompt = compiled.systemPrompt;

    // Initialize providers (idempotent) and set data for this execution
    initializeReminderProviders();
    getSystemReminderContext().advance();

    const rawDTag = projectContext.project.dTag || projectContext.project.tagValue("d");
    const dTag = rawDTag ? createProjectDTag(rawDTag) : undefined;
    const conversationsContent = renderConversationsReminder({
        agentPubkey: context.agent.pubkey,
        currentConversationId: context.conversationId,
        projectId: dTag,
    });

    updateReminderData({
        agent: context.agent,
        conversation,
        respondingToPrincipal: context.triggeringEnvelope.principal,
        pendingDelegations,
        completedDelegations,
        conversationsContent: conversationsContent ?? undefined,
        loadedSkills: skillResult.skills,
        skillToolPermissions: skillResult.toolPermissions,
        projectPath: context.projectBasePath || undefined,
    });

    const reminderStateBefore = JSON.stringify(
        conversation.getAgentPromptHistory(context.agent.pubkey).reminderDeltaState
    );
    const reminderOverlay = await collectSystemReminderOverlayMessage(trace.getActiveSpan());
    const reminderStateAfter = JSON.stringify(
        conversation.getAgentPromptHistory(context.agent.pubkey).reminderDeltaState
    );
    const promptHistoryResult = buildPromptHistoryMessages({
        compiled,
        conversationStore: conversation,
        agentPubkey: context.agent.pubkey,
        runtimeOverlay: reminderOverlay,
        reminderStateChanged: reminderStateBefore !== reminderStateAfter,
        span: trace.getActiveSpan(),
    });
    const messages = promptHistoryResult.messages;

    if (promptHistoryResult.didMutateHistory || promptHistoryResult.reminderStateChanged) {
        await conversation.save();
    }

    trace.getActiveSpan()?.addEvent("executor.messages_built_from_store", {
        "ral.number": ralNumber,
        "message.count": compiled.counts.total,
        "system_prompt.count": compiled.counts.systemPrompt,
        "conversation.count": compiled.counts.conversation,
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
        analysisContext: {
            projectId: projectContext.project.dTag || projectContext.project.tagValue("d") || undefined,
            conversationId: context.conversationId,
            agentSlug: context.agent.slug,
            agentId: context.agent.pubkey,
        },
    });

    return {
        toolsObject,
        llmService,
        messageCompiler,
        request,
        contextManagement,
        skillToolPermissions: skillResult.toolPermissions,
        abortSignal,
        metaModelSystemPrompt,
        variantSystemPrompt,
    };
}
