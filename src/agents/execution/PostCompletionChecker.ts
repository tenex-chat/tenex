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
    MAX_SUPERVISION_RETRIES,
    type PostCompletionContext,
} from "@/agents/supervision";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { CompleteEvent } from "@/llm/types";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import { getToolsObject } from "@/tools/registry";
import type { FullRuntimeContext } from "./types";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { shortenConversationId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import { STORAGE_PREFIX_LENGTH } from "@/utils/nostr-entity-parser";
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

function isRepeatableReEngagingViolation(
    enforcementMode: string | undefined,
    action: { type: string; reEngage: boolean }
): boolean {
    return enforcementMode === "repeat-until-resolved"
        && action.type === "suppress-publish"
        && action.reEngage;
}

function buildFinalRepeatableCorrectionMessage(baseMessage?: string): string {
    const sections: string[] = [];
    const trimmedBaseMessage = baseMessage?.trim();

    if (trimmedBaseMessage) {
        sections.push(trimmedBaseMessage);
    }

    sections.push("This turn still cannot complete.");
    sections.push(
        "Do not try to finish again until you resolve the issue in structured state."
    );
    sections.push(`Choose one of these paths:
- Continue the work and update your state as you go
- Use \`ask()\` if you need user input or external confirmation
- Use \`todo_write\` to update stale todo items and mark irrelevant items as \`skipped\` with \`skip_reason\`
- If the issue is a missing response, provide the missing response instead of ending silently`);

    return sections.join("\n\n");
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
    const supervisionState = supervisorOrchestrator.getSupervisionState(executionId);
    if (supervisionState.retryCount >= MAX_SUPERVISION_RETRIES) {
        logger.warn("[PostCompletionChecker] Supervision retries exhausted - repeatable gates remain active", {
            agent: agent.slug,
            ralNumber,
            retryCount: supervisionState.retryCount,
        });
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

    // Reuse cached system prompt from initial compilation when available
    const conversation = context.getConversation();
    const systemPrompt = context.cachedSystemPrompt
        ?? (conversation
            ? (await buildSystemPromptMessages({
                agent,
                project: projectContext.project,
                conversation,
                triggeringEnvelope: context.triggeringEnvelope,
                projectBasePath: context.projectBasePath,
                workingDirectory: context.workingDirectory,
                currentBranch: context.currentBranch,
                availableAgents: Array.from(projectContext.agents.values()),
            })).map(m => m.message.content).join("\n\n")
            : "");

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
    const silentCompletionRequested = ralRegistry.isSilentCompletionRequested(
        agent.pubkey,
        context.conversationId,
        ralNumber
    );

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
            .map(d => d.delegationConversationId.substring(0, STORAGE_PREFIX_LENGTH));
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
            "agent.pubkey": agent.pubkey.substring(0, STORAGE_PREFIX_LENGTH),
            "conversation.id": shortenConversationId(context.conversationId),
            "ral.number": ralNumber,
            "delegation.pending_count": pendingDelegationCount,
        });
    }

    const supervisionContext: PostCompletionContext = {
        agentSlug: agent.slug,
        agentPubkey: agent.pubkey,
        silentCompletionRequested,
        messageContent: completionEvent.message || "",
        outputTokens: completionEvent.usage.outputTokens ?? 0,
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
        usedErrorFallback: completionEvent.usedErrorFallback,
    };

    const supervisionResult = await supervisorOrchestrator.checkPostCompletion(supervisionContext, executionId);

    if (supervisionResult.hasViolation && supervisionResult.correctionAction) {
        if (!supervisionResult.heuristicId) {
            throw new Error("[PostCompletionChecker] Missing heuristic id for supervision violation.");
        }

        trace.getActiveSpan()?.addEvent("executor.supervision_violation", {
            "ral.number": ralNumber,
            "heuristic.id": supervisionResult.heuristicId,
            "action.type": supervisionResult.correctionAction.type,
            "heuristic.enforcement_mode": supervisionResult.enforcementMode || "once-per-execution",
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
            const repeatableReEngagingViolation = isRepeatableReEngagingViolation(
                supervisionResult.enforcementMode,
                supervisionResult.correctionAction
            );
            const retryCountBeforeCorrection = supervisionState.retryCount;
            const shouldUseFinalCorrection = repeatableReEngagingViolation
                && retryCountBeforeCorrection + 1 >= MAX_SUPERVISION_RETRIES;
            const finalCorrectionMessage = buildFinalRepeatableCorrectionMessage(
                supervisionResult.correctionAction.message
            );
            const correctionMessage = shouldUseFinalCorrection
                ? finalCorrectionMessage
                : supervisionResult.correctionAction.message;

            if (repeatableReEngagingViolation) {
                trace.getActiveSpan()?.addEvent("executor.supervision_repeatable_gate_triggered", {
                    "heuristic.id": supervisionResult.heuristicId,
                    "ral.number": ralNumber,
                    "retry.count_before": retryCountBeforeCorrection,
                    "retry.limit": MAX_SUPERVISION_RETRIES,
                    "retry.final_correction": shouldUseFinalCorrection,
                });
            }

            if (shouldUseFinalCorrection) {
                trace.getActiveSpan()?.addEvent("executor.supervision_final_correction", {
                    "heuristic.id": supervisionResult.heuristicId,
                    "ral.number": ralNumber,
                    "retry.count_before": retryCountBeforeCorrection,
                    "retry.limit": MAX_SUPERVISION_RETRIES,
                    "message_length": finalCorrectionMessage.length,
                });
            }

            // Add telemetry for supervision correction diagnosis
            trace.getActiveSpan()?.addEvent("executor.supervision_correction", {
                "has_message": !!correctionMessage,
                "message_length": correctionMessage?.length || 0,
                "heuristic.id": supervisionResult.heuristicId,
                "action.type": supervisionResult.correctionAction.type,
                "action.reEngage": supervisionResult.correctionAction.reEngage,
            });

            supervisionState.lastHeuristicTriggered = supervisionResult.heuristicId;

            // Increment retry count until the final correction threshold is reached
            if (retryCountBeforeCorrection < MAX_SUPERVISION_RETRIES) {
                supervisorOrchestrator.incrementRetryCount(executionId);
            }

            // Non-repeatable heuristics still enforce once per execution
            if (supervisionResult.heuristicId && !repeatableReEngagingViolation) {
                supervisorOrchestrator.markHeuristicEnforced(executionId, supervisionResult.heuristicId);
            }

            if (correctionMessage) {
                getSystemReminderContext().queue({
                    type: "supervision-correction",
                    content: correctionMessage,
                });
            }

            return {
                shouldReEngage: true,
                correctionMessage,
                injectedMessage: false,
            };
        }

        if (supervisionResult.correctionAction.type === "inject-message" &&
            supervisionResult.correctionAction.message) {
            getSystemReminderContext().queue({
                type: "supervision-message",
                content: supervisionResult.correctionAction.message,
            });

            trace.getActiveSpan()?.addEvent("executor.supervision_deferred_injection", {
                "ral.number": ralNumber,
                "heuristic.id": supervisionResult.heuristicId,
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
