import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { context as otelContext, trace } from "@opentelemetry/api";
import chalk from "chalk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import type { ExecutionContext } from "../agents/execution/types";
import type { AgentInstance } from "../agents/types";
import type { Conversation, ConversationCoordinator } from "../conversations";
import { ConversationResolver } from "../conversations/services/ConversationResolver";
// New refactored modules
import { AgentEventDecoder } from "../nostr/AgentEventDecoder";
import { TagExtractor } from "../nostr/TagExtractor";
import { getProjectContext } from "../services";
import { BrainstormService } from "../services/BrainstormService";
import { llmOpsRegistry } from "../services/LLMOperationsRegistry";
import { formatAnyError } from "../utils/error-formatter";
import { getCurrentBranch } from "../utils/git/initializeGitRepo";
import { logger } from "../utils/logger";
import { AgentRouter } from "./AgentRouter";

const tracer = trace.getTracer("tenex.event-handler");

interface EventHandlerContext {
    conversationCoordinator: ConversationCoordinator;
    agentExecutor: AgentExecutor;
}

/**
 * Check if an event is a brainstorm event
 */
function isBrainstormEvent(event: NDKEvent): boolean {
    if (event.kind !== 11) return false;

    return TagExtractor.hasMode(event, "brainstorm");
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
    const systemPubkeys = Array.from(projectCtx.agents.values()).map((a) => a.pubkey);
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
 */
async function executeAgent(
    executionContext: ExecutionContext,
    agentExecutor: AgentExecutor,
    conversation: Conversation,
    projectManager: AgentInstance,
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
            : "⚠️ Unable to process your request due to an error. Please try again later.";

        // Use AgentPublisher to publish error
        const { AgentPublisher } = await import("@/nostr/AgentPublisher");
        const agentPublisher = new AgentPublisher(projectManager);

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
    const projectManager = projectCtx.getProjectManager();
    if (!projectManager) {
        throw new Error("Project Manager agent not found - required for conversation coordination");
    }

    // 1. Check if this is a brainstorm follow-up BEFORE creating orphaned conversations
    // Check if the event references a kind:11 event
    const referencedKind = AgentEventDecoder.getReferencedKind(event);
    const conversationRoot = AgentEventDecoder.getConversationRoot(event);

    if (referencedKind === "11" && conversationRoot) {
        // Try to find the root event to check if it's a brainstorm
        const existingConversation =
            conversationCoordinator.getConversationByEvent(conversationRoot);

        if (existingConversation) {
            const rootEvent = existingConversation.history[0];
            if (rootEvent && isBrainstormEvent(rootEvent)) {
                logger.info("Detected brainstorm follow-up, delegating to BrainstormService", {
                    eventId: event.id?.substring(0, 8),
                    rootId: rootEvent.id?.substring(0, 8),
                });

                const brainstormService = new BrainstormService(projectCtx);
                await brainstormService.handleFollowUp(event);
                return;
            }
        } else {
            // The root event doesn't exist in our conversation history yet
            // This might be a reply to a brainstorm that we haven't seen the root for
            // Check if it has brainstorm participant tags
            const hasParticipantTags = event.tags.some((tag) => tag[0] === "participant");
            const hasBrainstormModeTags = event.tags.some(
                (tag) => tag[0] === "mode" && tag[1] === "brainstorm"
            );

            if (hasParticipantTags || hasBrainstormModeTags) {
                logger.info(
                    "Detected orphaned brainstorm follow-up, delegating to BrainstormService",
                    {
                        eventId: event.id?.substring(0, 8),
                        conversationRoot,
                    }
                );
                // Process through BrainstormService even without existing conversation
                const brainstormService = new BrainstormService(projectCtx);
                await brainstormService.handleFollowUp(event);
                return;
            }
        }
    }

    // 2. Continue with normal resolution if not a brainstorm follow-up
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

    // 3.5. Check for active operations and inject message instead of starting new execution
    const operationsByEvent = llmOpsRegistry.getOperationsByEvent();
    const activeOperations = operationsByEvent.get(conversation.id) || [];

    logger.debug("[MessageInjection] Checking for active operations", {
        conversationId: conversation.id.substring(0, 8),
        targetAgents: targetAgents.map((a) => ({ name: a.name, pubkey: a.pubkey.substring(0, 8) })),
        activeOperations: activeOperations.map((op) => ({
            agentPubkey: op.agentPubkey.substring(0, 8),
            eventId: op.eventId.substring(0, 8),
        })),
    });

    // Filter target agents to only those with active operations
    const agentsToInject = targetAgents.filter((targetAgent) => {
        return activeOperations.some((op) => op.agentPubkey === targetAgent.pubkey);
    });

    logger.debug("[MessageInjection] Injection decision", {
        agentsToInject: agentsToInject.map((a) => a.name),
        willInject: agentsToInject.length > 0,
        willStartNew: targetAgents.length - agentsToInject.length,
    });

    // Inject message into active executions
    for (const targetAgent of agentsToInject) {
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
        }
    }

    // Remove agents that had active operations from the list to execute
    targetAgents = targetAgents.filter((agent) => !agentsToInject.includes(agent));

    // 4. Filter out self-replies (except for agents with delegate_phase tool)
    const nonSelfReplyAgents = AgentRouter.filterOutSelfReplies(event, targetAgents);

    // Check if any of the filtered agents have delegate_phase tool
    const selfReplyAgentsWithDelegatePhase = targetAgents.filter((agent) => {
        // Agent is p-tagging themselves AND has delegate_phase tool
        return agent.pubkey === event.pubkey && agent.tools?.includes("delegate_phase");
    });

    // Allow agents with delegate_phase to continue even if they're self-replying
    const finalTargetAgents = [...nonSelfReplyAgents, ...selfReplyAgentsWithDelegatePhase];

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
        const allowedSelfReplies = filteredAgents.filter((a) =>
            a.tools?.includes("delegate_phase")
        );
        const blockedSelfReplies = filteredAgents.filter(
            (a) => !a.tools?.includes("delegate_phase")
        );

        if (allowedSelfReplies.length > 0) {
            logger.info(
                chalk.gray(
                    `Allowing self-reply for agents with delegate_phase: ${allowedSelfReplies.map((a) => a.name).join(", ")}`
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
    const executionPromises = targetAgents.map(async (targetAgent) => {
        // Determine working directory and branch from event or current state
        const projectPath = projectCtx.agentRegistry.getBasePath();
        const branchTag = event.tags.find(t => t[0] === "branch")?.[1];

        let workingDirectory: string;
        let currentBranch: string;

        if (branchTag) {
            // Branch specified in event - resolve to worktree path
            const parentDir = path.dirname(projectPath);
            const worktreePath = path.join(parentDir, branchTag);

            // Verify worktree exists
            try {
                await fs.access(worktreePath);
                workingDirectory = worktreePath;
                currentBranch = branchTag;

                logger.debug("Using worktree from branch tag", {
                    branch: branchTag,
                    path: worktreePath
                });
            } catch {
                // Worktree doesn't exist - fall back to main worktree
                logger.warn("Branch tag specified but worktree not found, using main", {
                    branch: branchTag,
                    expectedPath: worktreePath
                });
                workingDirectory = projectPath;
                try {
                    currentBranch = await getCurrentBranch(projectPath);
                } catch (error) {
                    logger.error("Failed to get current branch, using 'main'", { projectPath, error });
                    currentBranch = "main";
                }
            }
        } else {
            // No branch tag - use current worktree
            workingDirectory = projectPath;
            try {
                currentBranch = await getCurrentBranch(projectPath);
            } catch (error) {
                logger.error("Failed to get current branch, using 'main'", { projectPath, error });
                currentBranch = "main";
            }
        }

        // Build execution context for this agent
        const executionContext: ExecutionContext = {
            agent: targetAgent,
            conversationId: conversation.id,
            projectPath,
            workingDirectory,
            currentBranch,
            triggeringEvent: event,
            conversationCoordinator,
            getConversation: () => conversationCoordinator.getConversation(conversation.id),
        };

        // Execute agent
        await executeAgent(executionContext, agentExecutor, conversation, projectManager, event);
    });

    // Wait for all agents to complete
    await Promise.all(executionPromises);
}
