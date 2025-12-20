import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import { createExecutionContext } from "../agents/execution/ExecutionContextFactory";
import type { ExecutionContext } from "../agents/execution/types";
import type { Conversation, ConversationCoordinator } from "../conversations";
import { ConversationResolver } from "../conversations/services/ConversationResolver";
import { AgentEventDecoder } from "../nostr/AgentEventDecoder";
import { getProjectContext } from "../services/ProjectContext";
import { RALRegistry } from "../services/ral";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "../utils/logger";
import { AgentRouter } from "./AgentRouter";
import { handleDelegationCompletion } from "./DelegationCompletionHandler";

interface EventHandlerContext {
    conversationCoordinator: ConversationCoordinator;
    agentExecutor: AgentExecutor;
}

/**
 * Main entry point for handling chat messages
 */
export const handleChatMessage = async (
    event: NDKEvent,
    context: EventHandlerContext
): Promise<void> => {
    const projectCtx = getProjectContext();

    // Check if this message is directed to the system using centralized decoder
    const isDirectedToSystem = AgentEventDecoder.isDirectedToSystem(event, projectCtx.agents);
    const isFromAgent = AgentEventDecoder.isEventFromAgent(event, projectCtx.agents);

    trace.getActiveSpan()?.addEvent("reply.message_received", {
        "event.id": event.id ?? "",
        "event.pubkey": event.pubkey?.substring(0, 8) ?? "",
        "message.preview": event.content.substring(0, 100),
        "routing.is_directed_to_system": isDirectedToSystem,
        "routing.is_from_agent": isFromAgent,
    });

    if (!isDirectedToSystem && isFromAgent) {
        // Agent event not directed to system - only add to conversation history, don't process
        trace.getActiveSpan()?.addEvent("reply.agent_event_not_directed", {
            "event.id": event.id ?? "",
        });

        // Try to find and update the conversation this event belongs to
        const resolver = new ConversationResolver(context.conversationCoordinator);
        const result = await resolver.resolveConversationForEvent(event);

        if (result.conversation) {
            // Add the event to conversation history without triggering any agent processing
            await context.conversationCoordinator.addEvent(result.conversation.id, event);
            trace.getActiveSpan()?.addEvent("reply.added_to_history", {
                "conversation.id": result.conversation.id,
            });
        } else {
            trace.getActiveSpan()?.addEvent("reply.no_conversation_found", {
                "event.id": event.id ?? "",
            });
        }
        return;
    }

    // Process the reply (triggers agent execution)
    try {
        await handleReplyLogic(event, context);
    } catch (error) {
        logger.error("Failed to route reply", {
            error: formatAnyError(error),
            eventId: event.id,
        });
    }
};

/**
 * Execute the agent with proper error handling
 */
async function executeAgent(
    executionContext: ExecutionContext,
    agentExecutor: AgentExecutor,
    conversation: Conversation,
    event: NDKEvent
): Promise<void> {
    try {
        await agentExecutor.execute(executionContext);
    } catch (error) {
        const errorMessage = formatAnyError(error);

        // Check if it's an insufficient credits error
        const isCreditsError =
            errorMessage.includes("Insufficient credits") || errorMessage.includes("402");

        const displayMessage = isCreditsError
            ? "⚠️ Unable to process your request: Insufficient credits. Please add more credits at https://openrouter.ai/settings/credits to continue."
            : `⚠️ Unable to process your request due to an error: ${errorMessage}`;

        // Use AgentPublisher to publish error
        const { AgentPublisher } = await import("@/nostr/AgentPublisher");
        const agentPublisher = new AgentPublisher(executionContext.agent);

        await agentPublisher.error(
            {
                message: displayMessage,
                errorType: isCreditsError ? "insufficient_credits" : "execution_error",
            },
            {
                triggeringEvent: event,
                rootEvent: conversation.history[0], // Root event is first in history
                conversationId: conversation.id,
            }
        );

        logger.error(
            isCreditsError
                ? "Agent execution failed due to insufficient credits"
                : "Agent execution failed",
            {
                error: errorMessage,
                conversation: conversation.id,
            }
        );
    }
}

/**
 * Main reply handling logic - orchestrates all the helper functions
 */
async function handleReplyLogic(
    event: NDKEvent,
    { conversationCoordinator, agentExecutor }: EventHandlerContext
): Promise<void> {
    const projectCtx = getProjectContext();

    // Resolve conversation for this event
    const conversationResolver = new ConversationResolver(conversationCoordinator);
    const { conversation, isNew } = await conversationResolver.resolveConversationForEvent(event);

    if (!conversation) {
        logger.error("No conversation found or created for event", {
            eventId: event.id,
            convRoot: AgentEventDecoder.getConversationRoot(event),
            kTag: AgentEventDecoder.getReferencedKind(event),
        });
        return;
    }

    // 2. Add event to conversation history immediately (if not new and not an internal message)
    // This ensures message persistence even if we inject it into a running execution
    if (!isNew && !AgentEventDecoder.isAgentInternalMessage(event)) {
        await conversationCoordinator.addEvent(conversation.id, event);
    }

    // 2.5. Record any delegation completion (side effect only)
    // This records the completion in RALRegistry so AgentExecutor can detect resumption
    // Routing is handled normally below - the agent will be resolved via p-tags
    const delegationResult = await handleDelegationCompletion(
        event,
        conversation,
        conversationCoordinator
    );

    // 2.6. If this was a delegation completion, check if we should skip execution
    // When a delegation response arrives but there are still pending delegations,
    // we just record it and wait - don't create a new RAL execution
    if (delegationResult.recorded && delegationResult.agentSlug) {
        const ralRegistry = RALRegistry.getInstance();
        const targetAgent = projectCtx.getAgent(delegationResult.agentSlug);

        if (targetAgent) {
            const activeRals = ralRegistry.getActiveRALs(targetAgent.pubkey, conversation.id);
            const ralWithPendingDelegations = activeRals.find(
                ral => ral.pendingDelegations.length > 0
            );

            if (ralWithPendingDelegations) {
                trace.getActiveSpan()?.addEvent("reply.delegation_recorded_waiting", {
                    "agent.slug": delegationResult.agentSlug,
                    "delegation.pending_count": ralWithPendingDelegations.pendingDelegations.length,
                    "delegation.completed_count": ralWithPendingDelegations.completedDelegations.length,
                });
                // Don't proceed with execution - just wait for remaining delegations
                return;
            }
        }
    }

    // 3. Determine target agents
    let targetAgents = AgentRouter.resolveTargetAgents(event, projectCtx);

    // Add telemetry for routing decision
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
        const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);
        activeSpan.addEvent("agent_routing", {
            "routing.mentioned_pubkeys_count": mentionedPubkeys.length,
            "routing.resolved_agent_count": targetAgents.length,
            "routing.agent_names": targetAgents.map((a) => a.name).join(", "),
            "routing.agent_roles": targetAgents.map((a) => a.role).join(", "),
        });
    }

    if (targetAgents.length === 0) {
        activeSpan?.addEvent("reply.no_target_agents", {
            "event.id": event.id ?? "",
        });
        return;
    }

    // 4. Filter out self-replies (except for agents with phases - they can self-delegate for phase transitions)
    const nonSelfReplyAgents = AgentRouter.filterOutSelfReplies(event, targetAgents);

    // Check if any of the filtered agents have phases defined (can self-delegate for phase transitions)
    const selfReplyAgentsWithPhases = targetAgents.filter((agent) => {
        // Agent is p-tagging themselves AND has phases defined
        return agent.pubkey === event.pubkey && agent.phases && Object.keys(agent.phases).length > 0;
    });

    // Allow agents with phases to continue even if they're self-replying (for phase transitions)
    const finalTargetAgents = [...nonSelfReplyAgents, ...selfReplyAgentsWithPhases];

    if (finalTargetAgents.length === 0) {
        activeSpan?.addEvent("reply.skipped_self_reply", {
            "routing.reason": "all_agents_would_process_own_message",
        });
        return;
    }

    // Record filtering decisions in trace
    if (nonSelfReplyAgents.length < targetAgents.length) {
        const filteredAgents = targetAgents.filter((a) => !nonSelfReplyAgents.includes(a));
        const allowedSelfReplies = filteredAgents.filter(
            (a) => a.phases && Object.keys(a.phases).length > 0
        );
        const blockedSelfReplies = filteredAgents.filter(
            (a) => !a.phases || Object.keys(a.phases).length === 0
        );

        activeSpan?.addEvent("reply.self_reply_filtering", {
            "filtering.allowed_with_phases": allowedSelfReplies.map((a) => a.name).join(", "),
            "filtering.blocked": blockedSelfReplies.map((a) => a.name).join(", "),
        });
    }

    targetAgents = finalTargetAgents;

    // 5. Execute each target agent in parallel
    const executionPromises = targetAgents.map(async (targetAgent) => {
        // Check if this agent has a resumable RAL - if so, use the original triggering event
        // This ensures p-tags go to the original requester, not the delegatee
        let triggeringEventForContext = event;
        const ralRegistry = RALRegistry.getInstance();
        const resumableRal = ralRegistry.findResumableRAL(targetAgent.pubkey, conversation.id);

        if (resumableRal?.originalTriggeringEventId) {
            const originalEvent = conversation.history.find(
                e => e.id === resumableRal.originalTriggeringEventId
            );
            if (originalEvent) {
                triggeringEventForContext = originalEvent;
                trace.getActiveSpan()?.addEvent("reply.restored_original_trigger", {
                    "agent.slug": targetAgent.slug,
                    "original.event_id": resumableRal.originalTriggeringEventId,
                    "resumption.event_id": event.id || "",
                });
            }
        }

        // Create execution context with environment resolution from event
        // The factory extracts branch tags and resolves worktrees internally
        const executionContext = await createExecutionContext({
            agent: targetAgent,
            conversationId: conversation.id,
            projectBasePath: projectCtx.agentRegistry.getBasePath(),
            triggeringEvent: triggeringEventForContext,
            conversationCoordinator,
        });

        // Execute agent
        await executeAgent(executionContext, agentExecutor, conversation, event);
    });

    // Wait for all agents to complete
    await Promise.all(executionPromises);
}
