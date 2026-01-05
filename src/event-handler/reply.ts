import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import { createExecutionContext } from "../agents/execution/ExecutionContextFactory";
import { ConversationStore } from "../conversations/ConversationStore";
import { ConversationResolver } from "../conversations/services/ConversationResolver";
import { ConversationSummarizer } from "../conversations/services/ConversationSummarizer";
import { metadataDebounceManager } from "../conversations/services/MetadataDebounceManager";
import { AgentEventDecoder } from "../nostr/AgentEventDecoder";
import { getProjectContext } from "@/services/projects";
import { config } from "@/services/ConfigService";
import { RALRegistry } from "../services/ral";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "../utils/logger";
import { AgentRouter } from "./AgentRouter";
import { handleDelegationCompletion } from "./DelegationCompletionHandler";

interface EventHandlerContext {
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
        const resolver = new ConversationResolver();
        const result = await resolver.resolveConversationForEvent(event);

        if (result.conversation) {
            // Add the event to conversation history without triggering any agent processing
            await ConversationStore.addEvent(result.conversation.id, event);
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
    { agentExecutor }: EventHandlerContext
): Promise<void> {
    const projectCtx = getProjectContext();

    // Resolve conversation for this event
    const conversationResolver = new ConversationResolver();
    const { conversation, isNew } = await conversationResolver.resolveConversationForEvent(event);

    if (!conversation) {
        logger.error("No conversation found or created for event", {
            eventId: event.id,
            replyTarget: AgentEventDecoder.getReplyTarget(event),
        });
        return;
    }

    // Check for duplicate event (our own published event coming back)
    // Skip check if isNew - the event was just added in create()
    if (!isNew && event.id && conversation.hasEventId(event.id)) {
        trace.getActiveSpan()?.addEvent("reply.skipped_duplicate_event", {
            "event.id": event.id,
            "conversation.id": conversation.id,
        });
        // Still add to store for consistency, but don't trigger agent
        if (!AgentEventDecoder.isAgentInternalMessage(event)) {
            await ConversationStore.addEvent(conversation.id, event);
        }
        return;
    }

    // Add event to conversation history immediately (if not new and not an internal message)
    if (!isNew && !AgentEventDecoder.isAgentInternalMessage(event)) {
        await ConversationStore.addEvent(conversation.id, event);
    }

    // Immediately generate metadata for new conversations (before agent execution)
    // This ensures the UI shows a proper title right away, not raw content
    if (isNew && !AgentEventDecoder.isAgentInternalMessage(event)) {
        // Mark first publish as done so post-execution metadata will debounce
        metadataDebounceManager.markFirstPublishDone(conversation.id);

        const summarizer = new ConversationSummarizer(projectCtx);
        summarizer.summarizeAndPublish(conversation).catch((error) => {
            logger.error("Failed to generate initial metadata for new conversation", {
                conversationId: conversation.id,
                error: formatAnyError(error),
            });
        });
        trace.getActiveSpan()?.addEvent("reply.initial_metadata_scheduled", {
            "conversation.id": conversation.id,
        });
    }

    // Check for delegation completion - if this is a response to a delegation,
    // route to the waiting agent in the ORIGINAL conversation (not this one)
    const delegationResult = await handleDelegationCompletion(event);
    const delegationTarget = AgentRouter.resolveDelegationTarget(delegationResult, projectCtx);

    if (delegationTarget) {
        // Look up the original triggering event from the RAL
        // This ensures we p-tag the original requester, not the delegatee
        const ralRegistry = RALRegistry.getInstance();
        const resumableRal = ralRegistry.findResumableRAL(
            delegationTarget.agent.pubkey,
            delegationTarget.conversationId
        );

        // Get the original triggering event for delegation resumption
        let triggeringEventForContext = event; // fallback to completion event

        if (resumableRal?.originalTriggeringEventId) {
            const originalEvent = ConversationStore.getCachedEvent(resumableRal.originalTriggeringEventId);
            if (originalEvent) {
                triggeringEventForContext = originalEvent;
                trace.getActiveSpan()?.addEvent("reply.restored_original_trigger_for_delegation", {
                    "original.event_id": resumableRal.originalTriggeringEventId,
                    "completion.event_id": event.id || "",
                });
            }
        }

        trace.getActiveSpan()?.addEvent("reply.delegation_routing_to_original", {
            "delegation.agent_slug": delegationTarget.agent.slug,
            "delegation.original_conversation_id": delegationTarget.conversationId,
            "delegation.current_conversation_id": conversation.id,
        });

        // Create execution context for the ORIGINAL conversation where the RAL is waiting
        const hasPendingDelegations = (delegationResult.pendingCount ?? 0) > 0;
        const executionContext = await createExecutionContext({
            agent: delegationTarget.agent,
            conversationId: delegationTarget.conversationId,
            projectBasePath: projectCtx.agentRegistry.getBasePath(),
            triggeringEvent: triggeringEventForContext,
            isDelegationCompletion: true,
            hasPendingDelegations,
        });

        // Reset metadata debounce timer before execution
        metadataDebounceManager.onAgentStart(delegationTarget.conversationId);

        // Execute - AgentExecutor will find the resumable RAL via findResumableRAL
        await agentExecutor.execute(executionContext);

        // Schedule debounced metadata publish for the ORIGINAL conversation
        // Delegation completions are never root events (they reply to a delegation)
        metadataDebounceManager.schedulePublish(
            delegationTarget.conversationId,
            false, // not a root event
            async () => {
                const summarizer = new ConversationSummarizer(projectCtx);
                const originalConversation = ConversationStore.get(delegationTarget.conversationId);
                if (originalConversation) {
                    await summarizer.summarizeAndPublish(originalConversation);
                }
            }
        );
        return;
    }

    // If this is a completion event but no delegation target was found, drop it.
    // This prevents orphan completions from triggering new RALs and causing ping-pong loops.
    if (AgentEventDecoder.isDelegationCompletion(event)) {
        trace.getActiveSpan()?.addEvent("reply.completion_dropped_no_waiting_ral", {
            "event.id": event.id ?? "",
            "event.pubkey": event.pubkey.substring(0, 8),
        });
        return;
    }

    trace.getActiveSpan()?.addEvent("reply.delegation_completion_handled");

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
    trace.getActiveSpan()?.addEvent("reply.before_agent_routing");
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

    // Reset metadata debounce timer before any agent execution
    metadataDebounceManager.onAgentStart(conversation.id);

    // Execute each target agent in parallel
    const executionPromises = targetAgents.map(async (targetAgent) => {
        const ralRegistry = RALRegistry.getInstance();
        const activeRal = ralRegistry.getState(targetAgent.pubkey, conversation.id);

        // Check if we should inject into an active execution instead of starting a new one
        if (activeRal && activeRal.isStreaming) {
            // RAL is actively streaming - inject message for next prepareStep
            ralRegistry.queueUserMessage(
                targetAgent.pubkey,
                conversation.id,
                activeRal.ralNumber,
                event.content
            );

            trace.getActiveSpan()?.addEvent("reply.message_injected", {
                "agent.slug": targetAgent.slug,
                "ral.number": activeRal.ralNumber,
                "message.length": event.content.length,
            });
            return; // Don't spawn new execution - active one will process on next step
        }

        // RAL either doesn't exist or isn't streaming (waiting for delegation).
        // If not streaming, inject the message so the new execution can pick it up.
        if (activeRal && !activeRal.isStreaming) {
            ralRegistry.queueUserMessage(
                targetAgent.pubkey,
                conversation.id,
                activeRal.ralNumber,
                event.content
            );
            trace.getActiveSpan()?.addEvent("reply.message_queued_for_resumption", {
                "agent.slug": targetAgent.slug,
                "ral.number": activeRal.ralNumber,
                "message.length": event.content.length,
            });
            // Fall through to spawn new execution - it will resume via findRALWithInjections
        }

        // Check if this agent has a resumable RAL - if so, use the original triggering event
        // This ensures p-tags go to the original requester, not the delegatee
        let triggeringEventForContext = event;
        const resumableRal = ralRegistry.findResumableRAL(targetAgent.pubkey, conversation.id);

        if (resumableRal?.originalTriggeringEventId) {
            const originalEvent = ConversationStore.getCachedEvent(resumableRal.originalTriggeringEventId);
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
        });

        // Execute agent (error handling is now in AgentExecutor)
        await agentExecutor.execute(executionContext);
    });

    await Promise.all(executionPromises);

    // Schedule debounced metadata publishing (kind 513) after agent execution
    // Always debounce: 10s delay if another message arrives, max 5 minutes
    // (Immediate generation for NEW conversations is handled earlier, before execution)
    if (!AgentEventDecoder.isAgentInternalMessage(event)) {
        metadataDebounceManager.schedulePublish(
            conversation.id,
            false, // Always debounce after execution
            async () => {
                const summarizer = new ConversationSummarizer(projectCtx);
                await summarizer.summarizeAndPublish(conversation);
            }
        );
        trace.getActiveSpan()?.addEvent("reply.summarization_scheduled", {
            "conversation.id": conversation.id,
            "debounced": true,
        });
    }
}
