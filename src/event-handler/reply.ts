import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import type { ExecutionContext } from "../agents/execution/types";
import type { AgentInstance } from "../agents/types";
import type { Conversation, ConversationCoordinator } from "../conversations";
import { ConversationResolver } from "../conversations/services/ConversationResolver";
// New refactored modules
import { AgentEventDecoder } from "../nostr/AgentEventDecoder";
import { getProjectContext } from "../services";
import { formatAnyError } from "../utils/error-formatter";
import { logger } from "../utils/logger";
import { AgentRouter } from "./AgentRouter";


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
  
  if (!isDirectedToSystem && isFromAgent) {
    // Agent event not directed to system - only add to conversation history, don't process
    logger.debug(`Agent event not directed to system - adding to history only: ${event.id?.substring(0, 8)}`);
    
    // Try to find and update the conversation this event belongs to
    const resolver = new ConversationResolver(context.conversationCoordinator);
    const result = await resolver.resolveConversationForEvent(event);
    
    if (result.conversation) {
      // Add the event to conversation history without triggering any agent processing
      await context.conversationCoordinator.addEvent(result.conversation.id, event);
      logger.debug(`Added agent response to conversation history: ${result.conversation.id.substring(0, 8)}`);
    } else {
      logger.debug(`Could not find conversation for agent event: ${event.id?.substring(0, 8)}`);
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

  // 1. Resolve conversation context
  const conversationResolver = new ConversationResolver(conversationCoordinator);
  const {
    conversation,
    isNew,
  } = await conversationResolver.resolveConversationForEvent(event);

  if (!conversation) {
    logger.error("No conversation found or created for event", {
      eventId: event.id,
      convRoot: AgentEventDecoder.getConversationRoot(event),
      kTag: AgentEventDecoder.getReferencedKind(event),
    });
    return;
  }

  // 2. Add event to conversation history (if not new and not an internal message)
  if (!isNew && !AgentEventDecoder.isAgentInternalMessage(event)) {
    await conversationCoordinator.addEvent(conversation.id, event);
  }

  // 3. Determine target agents
  let targetAgents = AgentRouter.resolveTargetAgents(event, projectCtx);
  if (targetAgents.length === 0) {
    logger.debug(`No target agents resolved for event: ${event.id?.substring(0, 8)}`);
    return;
  }

  // 4. Filter out self-replies
  const nonSelfReplyAgents = AgentRouter.filterOutSelfReplies(event, targetAgents);
  if (nonSelfReplyAgents.length === 0) {
    const routingReasons = AgentRouter.getRoutingReasons(event, targetAgents);
    logger.info(
      chalk.gray(
        `Skipping self-reply: all target agents would process their own message (${routingReasons})`
      )
    );
    return;
  }
  
  // Log if some agents were filtered out due to self-reply
  if (nonSelfReplyAgents.length < targetAgents.length) {
    const filteredAgents = targetAgents.filter(a => !nonSelfReplyAgents.includes(a));
    logger.info(
      chalk.gray(
        `Filtered out self-reply for: ${filteredAgents.map(a => a.name).join(", ")}`
      )
    );
  }
  
  targetAgents = nonSelfReplyAgents;

  // 5. Execute each target agent in parallel
  const executionPromises = targetAgents.map(async (targetAgent) => {
    // Build execution context for this agent
    const executionContext: ExecutionContext = {
      agent: targetAgent,
      conversationId: conversation.id,
      phase: conversation.phase,
      projectPath: process.cwd(),
      triggeringEvent: event,
      conversationCoordinator,
    };

    // Execute agent
    await executeAgent(
      executionContext,
      agentExecutor,
      conversation,
      projectManager,
      event
    );
  });
  
  // Wait for all agents to complete
  await Promise.all(executionPromises);
}
