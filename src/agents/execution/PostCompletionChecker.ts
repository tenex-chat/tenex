/**
 * Post-completion supervision checker for agent responses.
 *
 * Runs heuristics to detect suspicious agent behavior before publishing.
 * This includes todo list compliance, delegation validation, and other
 * behavioral checks defined in the supervision system.
 */
import {
    supervisorOrchestrator,
    updateKnownAgentSlugs,
    type PostCompletionContext,
} from "@/agents/supervision";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { CompleteEvent } from "@/llm/types";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { NudgeService } from "@/services/nudge";
import { getProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import { getToolsObject } from "@/tools/registry";
import type { FullRuntimeContext } from "./types";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";

export interface PostCompletionCheckResult {
    /**
     * Whether to suppress publishing and re-engage the agent
     */
    shouldReEngage: boolean;
    /**
     * Correction message to inject if re-engaging
     */
    correctionMessage?: string;
    /**
     * Whether a non-re-engaging message injection was queued
     */
    injectedMessage: boolean;
}

export interface PostCompletionCheckerConfig {
    agent: AgentInstance;
    context: FullRuntimeContext;
    conversationStore: ConversationStore;
    ralNumber: number;
    completionEvent: CompleteEvent;
}

/**
 * Run post-completion supervision check on agent response.
 *
 * @returns Result indicating whether to re-engage, inject messages, or proceed normally
 */
export async function checkPostCompletion(
    config: PostCompletionCheckerConfig
): Promise<PostCompletionCheckResult> {
    const { agent, context, conversationStore, ralNumber, completionEvent } = config;
    const ralRegistry = RALRegistry.getInstance();
    const executionId = `${agent.pubkey}:${context.conversationId}:${ralNumber}`;

    logger.debug("[PostCompletionChecker] Running supervision check", {
        agent: agent.slug,
        ralNumber,
    });

    // Check if we've exceeded max retries for supervision
    if (supervisorOrchestrator.hasExceededMaxRetries(executionId)) {
        logger.warn("[PostCompletionChecker] Supervision max retries exceeded, publishing anyway", {
            agent: agent.slug,
            ralNumber,
        });
        supervisorOrchestrator.clearState(executionId);
        return { shouldReEngage: false, injectedMessage: false };
    }

    // Build supervision context
    const projectContext = getProjectContext();

    // Get tool calls from conversation store
    const storeMessages = conversationStore?.getAllMessages() || [];
    const toolCallsMade = storeMessages
        .filter(m => m.ral === ralNumber && m.messageType === "tool-call" && m.toolData)
        .flatMap(m => m.toolData?.map(td => {
            if (td.type === "tool-call" && "toolName" in td) {
                return td.toolName;
            }
            return undefined;
        }).filter(Boolean) as string[] || []);

    // Build the system prompt for context
    const conversation = context.getConversation();

    // Fetch nudge content if triggering event has nudge tags
    const nudgeEventIds = AgentEventDecoder.extractNudgeEventIds(context.triggeringEvent);
    const nudgeContent = nudgeEventIds.length > 0
        ? await NudgeService.getInstance().fetchNudges(nudgeEventIds)
        : "";

    const systemPromptMessages = conversation ? await buildSystemPromptMessages({
        agent,
        project: projectContext.project,
        conversation,
        projectBasePath: context.projectBasePath,
        workingDirectory: context.workingDirectory,
        currentBranch: context.currentBranch,
        availableAgents: Array.from(projectContext.agents.values()),
        mcpManager: projectContext.mcpManager,
        agentLessons: projectContext.agentLessons,
        nudgeContent,
    }) : [];
    const systemPrompt = systemPromptMessages.map(m => m.message.content).join("\n\n");

    // Update known agent slugs for delegation heuristic
    updateKnownAgentSlugs(Array.from(projectContext.agents.values()).map(a => a.slug));

    // Build conversation history
    const conversationMessages = conversationStore
        ? await conversationStore.buildMessagesForRal(agent.pubkey, ralNumber)
        : [];

    const toolNames = agent.tools || [];
    const toolsObject = toolNames.length > 0 ? getToolsObject(toolNames, context) : {};

    // Check todo state for supervision context
    const todos = conversationStore
        ? conversationStore.getTodos(agent.pubkey)
        : [];
    const hasTodoList = todos.length > 0;
    const hasBeenNudgedAboutTodos = conversationStore
        ? conversationStore.hasBeenNudgedAboutTodos(agent.pubkey)
        : false;
    const hasBeenRemindedAboutTodos = conversationStore
        ? conversationStore.hasBeenRemindedAboutTodos(agent.pubkey)
        : false;

    const supervisionContext: PostCompletionContext = {
        agentSlug: agent.slug,
        agentPubkey: agent.pubkey,
        messageContent: completionEvent.message || "",
        toolCallsMade,
        systemPrompt,
        conversationHistory: conversationMessages,
        availableTools: toolsObject,
        hasTodoList,
        hasBeenNudgedAboutTodos,
        hasBeenRemindedAboutTodos,
        todos: todos.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            description: t.description,
        })),
    };

    const supervisionResult = await supervisorOrchestrator.checkPostCompletion(supervisionContext, executionId);

    if (supervisionResult.hasViolation && supervisionResult.correctionAction) {
        trace.getActiveSpan()?.addEvent("executor.supervision_violation", {
            "ral.number": ralNumber,
            "heuristic.id": supervisionResult.heuristicId || "unknown",
            "action.type": supervisionResult.correctionAction.type,
        });

        logger.info("[PostCompletionChecker] Supervision detected violation", {
            agent: agent.slug,
            heuristic: supervisionResult.heuristicId,
            actionType: supervisionResult.correctionAction.type,
        });

        // Mark agent as nudged if this was the todo nudge heuristic
        if (supervisionResult.heuristicId === "consecutive-tools-without-todo" && conversationStore) {
            conversationStore.setNudgedAboutTodos(agent.pubkey);
            await conversationStore.save();
        }

        // Mark agent as reminded if this was the todo reminder heuristic
        if (supervisionResult.heuristicId === "todo-reminder" && conversationStore) {
            conversationStore.setRemindedAboutTodos(agent.pubkey);
            await conversationStore.save();
        }

        if (supervisionResult.correctionAction.type === "suppress-publish" &&
            supervisionResult.correctionAction.reEngage) {
            // Add telemetry for supervision correction diagnosis
            trace.getActiveSpan()?.addEvent("executor.supervision_correction", {
                "has_message": !!supervisionResult.correctionAction.message,
                "message_length": supervisionResult.correctionAction.message?.length || 0,
                "heuristic.id": supervisionResult.heuristicId || "unknown",
                "action.type": supervisionResult.correctionAction.type,
                "action.reEngage": supervisionResult.correctionAction.reEngage,
            });

            // Increment retry count
            supervisorOrchestrator.incrementRetryCount(executionId);

            // Mark this heuristic as enforced so it won't fire again in this RAL
            if (supervisionResult.heuristicId) {
                supervisorOrchestrator.markHeuristicEnforced(executionId, supervisionResult.heuristicId);
            }

            // Inject correction message as ephemeral user message
            if (supervisionResult.correctionAction.message) {
                ralRegistry.queueUserMessage(
                    agent.pubkey,
                    context.conversationId,
                    ralNumber,
                    supervisionResult.correctionAction.message,
                    { ephemeral: true }
                );
            }

            return {
                shouldReEngage: true,
                correctionMessage: supervisionResult.correctionAction.message,
                injectedMessage: false,
            };
        } else if (supervisionResult.correctionAction.type === "inject-message" &&
            supervisionResult.correctionAction.message) {
            // Queue message for agent's next execution (no re-engage)
            ralRegistry.queueSystemMessage(
                agent.pubkey,
                context.conversationId,
                ralNumber,
                supervisionResult.correctionAction.message
            );

            return {
                shouldReEngage: false,
                injectedMessage: true,
            };
        }
    } else {
        logger.debug("[PostCompletionChecker] Supervision check passed", {
            agent: agent.slug,
            ralNumber,
        });
    }

    return { shouldReEngage: false, injectedMessage: false };
}
