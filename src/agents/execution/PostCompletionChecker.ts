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
import { shortenConversationId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import { PREFIX_LENGTH } from "@/utils/nostr-entity-parser";
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
    const hasBeenNudgedAboutTodos = conversationStore
        ? conversationStore.hasBeenNudgedAboutTodos(agent.pubkey)
        : false;

    // Get pending delegation count from RALRegistry (conversation-wide, not RAL-scoped)
    // We check ALL pending delegations for this conversation because a delegation from
    // an earlier RAL that hasn't completed yet should still suppress the pending-todos heuristic
    const pendingDelegations = ralRegistry.getConversationPendingDelegations(
        agent.pubkey,
        context.conversationId
        // Note: ralNumber is intentionally omitted to get conversation-wide scope
    );
    const pendingDelegationCount = pendingDelegations.length;

    // Emit telemetry only when pending delegations exist (avoids noisy zero-count events)
    if (pendingDelegationCount > 0) {
        // Cap delegation IDs to first 5 to prevent unbounded output
        const maxDelegationsToLog = 5;
        const delegationIds = pendingDelegations
            .slice(0, maxDelegationsToLog)
            .map(d => d.delegationConversationId.substring(0, PREFIX_LENGTH));
        const truncatedIndicator = pendingDelegationCount > maxDelegationsToLog
            ? ` (+${pendingDelegationCount - maxDelegationsToLog} more)`
            : "";

        logger.debug("[PostCompletionChecker] Pending delegations detected; pending-todos heuristic may be suppressed", {
            agent: agent.slug,
            pendingDelegationCount,
            delegationIds: `[${delegationIds.join(", ")}]${truncatedIndicator}`,
        });

        trace.getActiveSpan()?.addEvent("executor.supervision_pending_delegations", {
            "agent.slug": agent.slug,
            "agent.pubkey": agent.pubkey.substring(0, PREFIX_LENGTH),
            "conversation.id": shortenConversationId(context.conversationId),
            "ral.number": ralNumber,
            "delegation.pending_count": pendingDelegationCount,
        });
    }

    const supervisionContext: PostCompletionContext = {
        agentSlug: agent.slug,
        agentPubkey: agent.pubkey,
        messageContent: completionEvent.message || "",
        toolCallsMade,
        systemPrompt,
        conversationHistory: conversationMessages,
        availableTools: toolsObject,
        hasBeenNudgedAboutTodos,
        todos: todos.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            description: t.description,
        })),
        pendingDelegationCount,
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
            // Store message for agent's NEXT turn (not current RAL).
            // Using deferredInjections instead of ralRegistry.queueSystemMessage() ensures
            // this does NOT count as "outstanding work" and allows the agent to complete()
            // properly. The message will be picked up at the start of the agent's next turn.
            conversationStore.addDeferredInjection({
                targetPubkey: agent.pubkey,
                role: "system",
                content: supervisionResult.correctionAction.message,
                queuedAt: Date.now(),
                source: `supervision:${supervisionResult.heuristicId || "unknown"}`,
            });
            await conversationStore.save();

            trace.getActiveSpan()?.addEvent("executor.supervision_deferred_injection", {
                "ral.number": ralNumber,
                "heuristic.id": supervisionResult.heuristicId || "unknown",
                "message_length": supervisionResult.correctionAction.message.length,
            });

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
