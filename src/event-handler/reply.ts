import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { context as otelContext, trace } from "@opentelemetry/api";
import chalk from "chalk";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import { createExecutionContext } from "../agents/execution/ExecutionContextFactory";
import type { ExecutionContext } from "../agents/execution/types";
import type { AgentInstance } from "../agents/types";
import type { Conversation, ConversationCoordinator } from "../conversations";
import { ConversationResolver } from "../conversations/services/ConversationResolver";
// New refactored modules
import { AgentEventDecoder } from "../nostr/AgentEventDecoder";
import { TagExtractor } from "../nostr/TagExtractor";
import { getProjectContext } from "../services/ProjectContext";
import { llmOpsRegistry } from "../services/LLMOperationsRegistry";
import { executionCoordinator, ClawbackAbortError } from "../services/execution";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "../utils/logger";
import { AgentRouter } from "./AgentRouter";

const tracer = trace.getTracer("tenex.event-handler");

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
    logger.info(
        chalk.gray("Message: ") +
            chalk.white(event.content.substring(0, 100) + (event.content.length > 100 ? "..." : ""))
    );

    const projectCtx = getProjectContext();

    // Check if this message is directed to the system using centralized decoder
    const isDirectedToSystem = AgentEventDecoder.isDirectedToSystem(event, projectCtx.agents);
    const isFromAgent = AgentEventDecoder.isEventFromAgent(event, projectCtx.agents);

    // DEBUG: Log filtering decision for delegation events
    const pTags = TagExtractor.getPTags(event);
    const systemPubkeys = Array.from(projectCtx.agents.values()).map((a: AgentInstance) => a.pubkey);
    logger.debug("[EventFilter] Checking event", {
        eventId: event.id?.substring(0, 8),
        eventPubkey: event.pubkey?.substring(0, 8),
        isDirectedToSystem,
        isFromAgent,
        willFilter: !isDirectedToSystem && isFromAgent,
        pTags: pTags.map((pk) => pk?.substring(0, 8)),
        systemPubkeys: systemPubkeys.map((pk) => pk.substring(0, 8)),
    });

    if (!isDirectedToSystem && isFromAgent) {
        // Agent event not directed to system - only add to conversation history, don't process
        logger.debug(
            `Agent event not directed to system - adding to history only: ${event.id?.substring(0, 8)}`
        );

        // Try to find and update the conversation this event belongs to
        const resolver = new ConversationResolver(context.conversationCoordinator);
        const result = await resolver.resolveConversationForEvent(event);

        if (result.conversation) {
            // Add the event to conversation history without triggering any agent processing
            await context.conversationCoordinator.addEvent(result.conversation.id, event);
            logger.debug(
                `Added agent response to conversation history: ${result.conversation.id.substring(0, 8)}`
            );
        } else {
            logger.debug(
                `Could not find conversation for agent event: ${event.id?.substring(0, 8)}`
            );
        }
        return;
    }

    // Process the reply (triggers agent execution)
    try {
        await handleReplyLogic(event, context);
    } catch (error) {
        logger.info(chalk.red(`❌ Failed to route reply: ${formatAnyError(error)}`));
    }
};

/**
 * Execute the agent with proper error handling
 * Handles ClawbackAbortError by re-executing the agent
 *
 * @param executionContext - The execution context for the agent
 * @param agentExecutor - The agent executor instance
 * @param conversation - The conversation being processed
 * @param event - The triggering event
 * @param conversationCoordinator - The conversation coordinator
 * @param projectBasePath - The project base path
 * @param recursionDepth - Current recursion depth for clawback retries (default: 0)
 * @throws Error if maximum clawback recursion depth is exceeded
 */
async function executeAgent(
    executionContext: ExecutionContext,
    agentExecutor: AgentExecutor,
    conversation: Conversation,
    event: NDKEvent,
    conversationCoordinator: ConversationCoordinator,
    projectBasePath: string,
    recursionDepth = 0
): Promise<void> {
    const MAX_CLAWBACK_RECURSION = 5;

    if (recursionDepth >= MAX_CLAWBACK_RECURSION) {
        const errorMsg = `Maximum clawback recursion depth (${MAX_CLAWBACK_RECURSION}) exceeded`;
        logger.error("[executeAgent] Max recursion depth exceeded", {
            agent: executionContext.agent.slug,
            conversationId: conversation.id.substring(0, 8),
            depth: recursionDepth,
        });
        throw new Error(errorMsg);
    }
    try {
        await agentExecutor.execute(executionContext);
    } catch (error) {
        // Handle ClawbackAbortError - re-execute the agent
        // The message is already in conversation history, so a fresh execution will pick it up
        if (error instanceof ClawbackAbortError) {
            logger.info("[executeAgent] Clawback triggered, re-executing agent", {
                agent: executionContext.agent.slug,
                reason: error.reason,
                conversationId: conversation.id.substring(0, 8),
            });

            // Create a fresh execution context
            const freshContext = await createExecutionContext({
                agent: executionContext.agent,
                conversationId: conversation.id,
                projectBasePath,
                triggeringEvent: event,
                conversationCoordinator,
            });

            // Re-execute with fresh context and incremented recursion depth
            return executeAgent(
                freshContext,
                agentExecutor,
                conversation,
                event,
                conversationCoordinator,
                projectBasePath,
                recursionDepth + 1
            );
        }

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
 *
 * This function is the core of the event processing pipeline:
 * 1. Resolves the conversation for the incoming event
 * 2. Adds the event to conversation history
 * 3. Determines target agents using AgentRouter
 * 4. Uses ExecutionCoordinator for intelligent routing decisions
 * 5. Executes agents in parallel (either by injection or new execution)
 *
 * @param event - The incoming event to handle
 * @param context - Handler context containing conversation coordinator and agent executor
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
        logger.debug(`No target agents resolved for event: ${event.id?.substring(0, 8)}`);
        if (activeSpan) {
            activeSpan.addEvent("agent_routing_failed", { reason: "no_agents_resolved" });
        }
        return;
    }

    // 3.5. Use ExecutionCoordinator for intelligent routing decisions
    const agentsToInject: AgentInstance[] = [];
    const agentsToStartNew: AgentInstance[] = [];

    for (const targetAgent of targetAgents) {
        const decision = await executionCoordinator.routeMessage({
            agent: targetAgent,
            event,
            conversation,
        });

        logger.debug("[ExecutionCoordinator] Routing decision", {
            agent: targetAgent.name,
            decision: decision.type,
            reason: decision.reason,
        });

        switch (decision.type) {
            case "inject": {
                // Inject message into active execution via LLMOpsRegistry
                const operationsByEvent = llmOpsRegistry.getOperationsByEvent();
                const activeOperations = operationsByEvent.get(conversation.id) || [];
                const activeOp = activeOperations.find((op) => op.agentPubkey === targetAgent.pubkey);

                if (activeOp) {
                    const span = tracer.startSpan("tenex.message_injection.emit", {
                        attributes: {
                            "agent.name": targetAgent.name,
                            "agent.pubkey": targetAgent.pubkey,
                            "conversation.id": conversation.id,
                            "event.id": event.id || "",
                            "event.kind": event.kind || 0,
                            "operation.id": activeOp.id,
                        },
                    });

                    otelContext.with(trace.setSpan(otelContext.active(), span), () => {
                        logger.info("[MessageInjection] Injecting message into active execution", {
                            agent: targetAgent.name,
                            conversationId: conversation.id.substring(0, 8),
                            eventId: event.id?.substring(0, 8),
                        });
                        activeOp.eventEmitter.emit("inject-message", event);
                        span.addEvent("message.injected");
                        span.end();
                    });

                    agentsToInject.push(targetAgent);
                }
                break;
            }

            case "start-new":
                agentsToStartNew.push(targetAgent);
                break;

            case "clawback":
                // Abort the existing operation explicitly before starting a new one
                // This prevents race conditions where the old operation continues running
                llmOpsRegistry.stopByEventId(conversation.id);
                executionCoordinator.unregisterOperation(decision.operationId);
                logger.info("[ExecutionCoordinator] Clawback: aborted old operation, starting fresh", {
                    agent: targetAgent.name,
                    abortedOperationId: decision.operationId.substring(0, 8),
                    reason: decision.reason,
                });
                agentsToStartNew.push(targetAgent);
                break;

            case "start-concurrent":
                // NOTE: Concurrent execution is not yet implemented.
                // The ExecutionCoordinator now falls back to inject internally,
                // so this case should not be reached. If it is, treat as inject.
                logger.error("[ExecutionCoordinator] Unexpected start-concurrent decision - should not reach here", {
                    agent: targetAgent.name,
                });
                break;
        }
    }

    logger.debug("[ExecutionCoordinator] Routing summary", {
        toInject: agentsToInject.map((a) => a.name),
        toStartNew: agentsToStartNew.map((a) => a.name),
    });

    // Update targetAgents to only those that need new execution
    targetAgents = agentsToStartNew;

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
        const routingReasons = AgentRouter.getRoutingReasons(event, targetAgents);
        logger.info(
            chalk.gray(
                `Skipping self-reply: all target agents would process their own message (${routingReasons})`
            )
        );
        return;
    }

    // Log filtering actions
    if (nonSelfReplyAgents.length < targetAgents.length) {
        const filteredAgents = targetAgents.filter((a) => !nonSelfReplyAgents.includes(a));
        const allowedSelfReplies = filteredAgents.filter(
            (a) => a.phases && Object.keys(a.phases).length > 0
        );
        const blockedSelfReplies = filteredAgents.filter(
            (a) => !a.phases || Object.keys(a.phases).length === 0
        );

        if (allowedSelfReplies.length > 0) {
            logger.info(
                chalk.gray(
                    `Allowing self-reply for agents with phases: ${allowedSelfReplies.map((a) => a.name).join(", ")}`
                )
            );
        }

        if (blockedSelfReplies.length > 0) {
            logger.info(
                chalk.gray(
                    `Filtered out self-reply for: ${blockedSelfReplies.map((a) => a.name).join(", ")}`
                )
            );
        }
    }

    targetAgents = finalTargetAgents;

    // 5. Execute each target agent in parallel
    const projectBasePath = projectCtx.agentRegistry.getBasePath();
    const executionPromises = targetAgents.map(async (targetAgent) => {
        // Create execution context with environment resolution from event
        // The factory extracts branch tags and resolves worktrees internally
        const executionContext = await createExecutionContext({
            agent: targetAgent,
            conversationId: conversation.id,
            projectBasePath,
            triggeringEvent: event,
            conversationCoordinator,
        });

        // Execute agent (handles ClawbackAbortError internally by re-executing)
        await executeAgent(
            executionContext,
            agentExecutor,
            conversation,
            event,
            conversationCoordinator,
            projectBasePath
        );
    });

    // Wait for all agents to complete
    await Promise.all(executionPromises);
}
