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
import { DelegationRegistry } from "../services/DelegationRegistry";
import { formatAnyError } from "../utils/error-formatter";
import { logger } from "../utils/logger";
import { AgentRouter } from "./AgentRouter";
import { TaskCompletionHandler } from "./TaskCompletionHandler";

const logInfo = logger.info.bind(logger);

interface EventHandlerContext {
  conversationManager: ConversationCoordinator;
  agentExecutor: AgentExecutor;
}

/**
 * Main entry point for handling chat messages
 */
export const handleChatMessage = async (
  event: NDKEvent,
  context: EventHandlerContext
): Promise<void> => {
  logInfo(
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
    const registry = DelegationRegistry.getInstance();
    const resolver = new ConversationResolver(context.conversationManager, registry);
    const result = await resolver.resolveConversationForEvent(event);
    
    if (result.conversation) {
      // Add the event to conversation history without triggering any agent processing
      await context.conversationManager.addEvent(result.conversation.id, event);
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
    logInfo(chalk.red(`❌ Failed to route reply: ${formatAnyError(error)}`));
  }
};

/**
 * Execute the agent with proper error handling
 */
async function executeAgent(
  executionContext: ExecutionContext,
  agentExecutor: AgentExecutor,
  conversation: Conversation,
  _conversationManager: ConversationCoordinator,
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
        type: "error",
        message: displayMessage,
        errorType: isCreditsError ? "insufficient_credits" : "execution_error",
      },
      {
        triggeringEvent: event,
        conversationEvent: conversation.history[0], // Root event is first in history
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
  { conversationManager, agentExecutor }: EventHandlerContext
): Promise<void> {
  const projectCtx = getProjectContext();
  const projectManager = projectCtx.getAgent("project-manager");
  if (!projectManager) {
    throw new Error("Project Manager agent not found - required for conversation coordination");
  }

  // 1. Resolve conversation context
  const conversationResolver = new ConversationResolver(
    conversationManager,
    DelegationRegistry.getInstance()
  );
  const {
    conversation,
    claudeSessionId: mappedClaudeSessionId,
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
    await conversationManager.addEvent(conversation.id, event);
  }

  // 3. Determine target agent
  let targetAgent = AgentRouter.resolveTargetAgent(event, projectCtx, projectManager);
  if (!targetAgent) {
    logger.debug(`No target agent resolved for event: ${event.id?.substring(0, 8)}`);
    return;
  }

  // 4. Check for self-reply
  if (AgentRouter.wouldBeSelfReply(event, targetAgent)) {
    const routingReason = AgentRouter.getRoutingReason(event, targetAgent, projectCtx);
    logInfo(
      chalk.gray(
        `Skipping self-reply: ${targetAgent.name} would process its own message (${routingReason})`
      )
    );
    return;
  }

  // 5. Handle task completion if applicable
  let isTaskCompletionReactivation = false;
  let replyTarget: NDKEvent | undefined = event;

  if (AgentEventDecoder.isTaskCompletionEvent(event)) {
    const taskCompletionResult = await TaskCompletionHandler.handleTaskCompletion(
      event,
      conversation,
      conversationManager
    );

    if (!taskCompletionResult.shouldReactivate) {
      // Still waiting for more tasks or other reasons not to reactivate
      return;
    }

    isTaskCompletionReactivation = true;
    if (taskCompletionResult.targetAgent) {
      targetAgent = taskCompletionResult.targetAgent;
    }
    if (taskCompletionResult.replyTarget) {
      replyTarget = taskCompletionResult.replyTarget;
      logInfo(
        chalk.cyan(
          `Task completion will reply to original user event: ${replyTarget.id?.substring(0, 8)}`
        )
      );
    }
  }

  // 6. Extract claude-session
  const claudeSessionId = mappedClaudeSessionId || AgentEventDecoder.getClaudeSessionId(event);
  if (claudeSessionId) {
    logInfo(
      chalk.gray("Passing claude-session to execution context: ") +
        chalk.cyan(claudeSessionId) +
        (mappedClaudeSessionId ? chalk.gray(" (from task mapping)") : "")
    );
  }

  // 7. Build execution context
  const executionContext: ExecutionContext = {
    agent: targetAgent,
    conversationId: conversation.id,
    phase: conversation.phase,
    projectPath: process.cwd(),
    triggeringEvent: event,
    replyTarget: replyTarget,
    conversationManager,
    claudeSessionId,
    agentExecutor,
    isTaskCompletionReactivation,
  };

  // 8. Execute agent
  await executeAgent(
    executionContext,
    agentExecutor,
    conversation,
    conversationManager,
    projectManager,
    event
  );
}
