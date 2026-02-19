/**
 * StreamSetup - Handles pre-stream setup for LLM execution
 *
 * This module contains the setup logic that prepares everything needed
 * before streaming begins: tool wrapping, session management, injection processing,
 * meta model resolution, and initial message compilation.
 */

import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { config as configService } from "@/services/ConfigService";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { NudgeService, type NudgeToolPermissions, type NudgeData } from "@/services/nudge";
import { SkillService, type SkillData } from "@/services/skill";
import { getProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import { getToolsObject } from "@/tools/registry";
import { logger } from "@/utils/logger";
import type { ModelMessage } from "ai";
import { trace } from "@opentelemetry/api";
import type { LLMService } from "@/llm/service";
import { llmServiceFactory } from "@/llm/LLMServiceFactory";
import { MessageCompiler } from "./MessageCompiler";
import { SessionManager } from "./SessionManager";
import type { ToolExecutionTracker } from "./ToolExecutionTracker";
import { wrapToolsWithSupervision } from "./ToolSupervisionWrapper";
import type { FullRuntimeContext } from "./types";
import type { AISdkTool } from "@/tools/types";

/**
 * Result of stream setup
 */
export interface StreamSetupResult {
    toolsObject: Record<string, AISdkTool>;
    sessionManager: SessionManager;
    llmService: LLMService;
    messageCompiler: MessageCompiler;
    messages: ModelMessage[];
    ephemeralMessages: Array<{ role: "user" | "system"; content: string }>;
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
    /** Optional dedicated LLM service for compression operations */
    compressionLlmService?: LLMService;
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
    // === FETCH NUDGES FIRST ===
    // Must fetch nudges BEFORE getToolsObject because nudges can modify available tools
    const nudgeEventIds = AgentEventDecoder.extractNudgeEventIds(context.triggeringEvent);
    const nudgeResult = nudgeEventIds.length > 0
        ? await NudgeService.getInstance().fetchNudgesWithPermissions(nudgeEventIds)
        : { nudges: [], content: "", toolPermissions: {} };

    // === FETCH SKILLS ===
    // Skills do NOT affect tools, but we fetch them early to download attached files
    const skillEventIds = AgentEventDecoder.extractSkillEventIds(context.triggeringEvent);
    const skillResult = skillEventIds.length > 0
        ? await SkillService.getInstance().fetchSkills(skillEventIds)
        : { skills: [], content: "" };

    // Now get tools with nudge permissions applied
    // IMPORTANT: Always call getToolsObject even with empty base tools,
    // because nudge permissions (allow-tool, only-tool) can grant tools
    // to agents that have no default tools configured.
    const toolNames = context.agent.tools || [];
    let toolsObject = getToolsObject(toolNames, context, nudgeResult.toolPermissions);

    // Wrap tools with pre-tool supervision checks
    toolsObject = wrapToolsWithSupervision(toolsObject, context);

    const sessionManager = new SessionManager(
        context.agent,
        context.conversationId,
        context.workingDirectory
    );
    const { sessionId } = sessionManager.getSession();

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
    const ephemeralMessages: Array<{ role: "user" | "system"; content: string }> = [];

    if (initialInjections.length > 0) {
        // Best-effort profile warming (non-blocking)
        injectionProcessor.warmSenderPubkeys(initialInjections);

        for (const injection of initialInjections) {
            if (injection.ephemeral) {
                ephemeralMessages.push({
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

        trace.getActiveSpan()?.addEvent("executor.initial_injections_consumed", {
            "ral.number": ralNumber,
            "injection.count": initialInjections.length,
            "injection.ephemeral_count": ephemeralMessages.length,
        });
    }

    const projectContext = getProjectContext();
    const conversation = context.getConversation();
    if (!conversation) {
        throw new Error(`Conversation ${context.conversationId} not found`);
    }

    // Build MCP config from project's running MCP servers
    // This allows Claude Code-based agents to spawn their own instances of external MCP servers
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
                conversationStore.updateMessageContent(firstUserMessage.id, resolution.strippedMessage);
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
        sessionId,
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

    // Resolve optional dedicated compression LLM service
    let compressionLlmService: LLMService | undefined;
    const { llms } = await configService.loadConfig();
    if (llms.compression) {
        const compressionConfig = configService.getLLMConfig(llms.compression);
        compressionLlmService = llmServiceFactory.createService(compressionConfig, {
            agentName: `${context.agent.slug}-compression`,
            sessionId: `compression-${context.conversationId.substring(0, 8)}`,
        });
    }

    const messageCompiler = new MessageCompiler(
        llmService.provider,
        sessionManager,
        conversationStore,
        llmService,
        compressionLlmService
    );

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

    const { messages, counts, mode } = await messageCompiler.compile({
        agent: context.agent,
        project: projectContext.project,
        conversation,
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
        respondingToPubkey: context.triggeringEvent.pubkey,
        pendingDelegations,
        completedDelegations,
        ralNumber,
        metaModelSystemPrompt,
        variantSystemPrompt,
        ephemeralMessages,
        availableNudges: projectContext.getAvailableNudges(),
    });

    trace.getActiveSpan()?.addEvent("executor.messages_built_from_store", {
        "ral.number": ralNumber,
        "message.count": counts.total,
        "system_prompt.count": counts.systemPrompt,
        "conversation.count": counts.conversation,
        "message.mode": mode,
    });

    return {
        toolsObject,
        sessionManager,
        llmService,
        messageCompiler,
        messages,
        ephemeralMessages,
        nudgeContent,
        nudges: nudgeResult.nudges,
        nudgeToolPermissions: nudgeResult.toolPermissions,
        skillContent: skillResult.content,
        skills: skillResult.skills,
        abortSignal,
        metaModelSystemPrompt,
        variantSystemPrompt,
        compressionLlmService,
    };
}
