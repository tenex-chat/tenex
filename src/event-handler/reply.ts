import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import { createExecutionContext } from "../agents/execution/ExecutionContextFactory";
import type { ConversationCoordinator } from "../conversations";
import { ConversationResolver } from "../conversations/services/ConversationResolver";
import { AgentEventDecoder } from "../nostr/AgentEventDecoder";
import { getProjectContext } from "@/services/projects";
import { config } from "@/services/ConfigService";
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
 * Main reply handling logic - orchestrates routing and execution
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

    // Add event to conversation history immediately (if not new and not an internal message)
    if (!isNew && !AgentEventDecoder.isAgentInternalMessage(event)) {
        await conversationCoordinator.addEvent(conversation.id, event);
    }

    // Record any delegation completion (side effect only)
    await handleDelegationCompletion(event, conversation, conversationCoordinator);

    // If sender is whitelisted, they can unblock any blocked agents they're messaging
    const whitelistedPubkeys = config.getConfig().whitelistedPubkeys ?? [];
    const whitelist = new Set(whitelistedPubkeys);
    if (whitelist.has(event.pubkey)) {
        const { unblocked } = AgentRouter.unblockAgent(event, conversation, projectCtx, whitelist);
        if (unblocked) {
            trace.getActiveSpan()?.addEvent("reply.agent_unblocked_by_whitelist", {
                "event.pubkey": event.pubkey.substring(0, 8),
            });
        }
    }

    // Determine target agents (passing conversation to filter blocked agents)
    const targetAgents = AgentRouter.resolveTargetAgents(event, projectCtx, conversation);

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

    // Filter out self-replies (phase-aware filtering is now in AgentRouter)
    const filteredAgents = AgentRouter.filterOutSelfReplies(event, targetAgents);

    if (filteredAgents.length === 0) {
        activeSpan?.addEvent("reply.skipped_self_reply", {
            "routing.reason": "all_agents_would_process_own_message",
        });
        return;
    }

    // Execute each target agent in parallel
    const executionPromises = filteredAgents.map(async (targetAgent) => {
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

        // Create execution context
        const executionContext = await createExecutionContext({
            agent: targetAgent,
            conversationId: conversation.id,
            projectBasePath: projectCtx.agentRegistry.getBasePath(),
            triggeringEvent: triggeringEventForContext,
            conversationCoordinator,
        });

        // Execute agent (error handling is now in AgentExecutor)
        await agentExecutor.execute(executionContext);
    });

    await Promise.all(executionPromises);
}
