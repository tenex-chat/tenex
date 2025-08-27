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
import { DelegationCompletionHandler } from "./DelegationCompletionHandler";

const logInfo = logger.info.bind(logger);

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
    const resolver = new ConversationResolver(context.conversationCoordinator, registry);
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
  _conversationCoordinator: ConversationCoordinator,
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
    const agentPublisher = new AgentPublisher(projectManager, _conversationCoordinator);

    await agentPublisher.error(
      {
        type: "error",
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
  const projectManager = projectCtx.getAgent("project-manager");
  if (!projectManager) {
    throw new Error("Project Manager agent not found - required for conversation coordination");
  }

  // 1. Resolve conversation context
  const conversationResolver = new ConversationResolver(
    conversationCoordinator,
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
    await conversationCoordinator.addEvent(conversation.id, event);
  }

  // 3. Determine target agents
  let targetAgents = AgentRouter.resolveTargetAgents(event, projectCtx, projectManager);
  if (targetAgents.length === 0) {
    logger.debug(`No target agents resolved for event: ${event.id?.substring(0, 8)}`);
    return;
  }

  // 4. Filter out self-replies
  const nonSelfReplyAgents = AgentRouter.filterOutSelfReplies(event, targetAgents);
  if (nonSelfReplyAgents.length === 0) {
    const routingReasons = AgentRouter.getRoutingReasons(event, targetAgents, projectCtx);
    logInfo(
      chalk.gray(
        `Skipping self-reply: all target agents would process their own message (${routingReasons})`
      )
    );
    return;
  }
  
  // Log if some agents were filtered out due to self-reply
  if (nonSelfReplyAgents.length < targetAgents.length) {
    const filteredAgents = targetAgents.filter(a => !nonSelfReplyAgents.includes(a));
    logInfo(
      chalk.gray(
        `Filtered out self-reply for: ${filteredAgents.map(a => a.name).join(", ")}`
      )
    );
  }
  
  targetAgents = nonSelfReplyAgents;

  // 5. Handle delegation completion if applicable (only for single agent case)
  let isDelegationCompletionReactivation = false;
  let delegationOverrideAgent: AgentInstance | null = null;
  let delegationOverrideEvent: NDKEvent | null = null;

  // Check for delegation completions only if:
  // 1. It's explicitly marked as complete (tool:complete), OR
  // 2. It e-tags a known delegation request
  if (event.kind === 1111 && AgentEventDecoder.isEventFromAgent(event, projectCtx.agents)) {
    // Only check for delegation completion if it has markers suggesting it might be one
    const hasCompletionMarker = AgentEventDecoder.isDelegationCompletion(event);
    const eTags = event.getMatchingTags("e");
    
    // Only proceed if there's evidence this might be a delegation completion
    if (hasCompletionMarker || eTags.length > 0) {
      const delegationCompletionResult = await DelegationCompletionHandler.handleDelegationCompletion(
        event,
        conversation,
        conversationCoordinator
      );

      if (delegationCompletionResult.shouldReactivate) {
        // This was a delegation completion and we should reactivate
        isDelegationCompletionReactivation = true;
        if (delegationCompletionResult.targetAgent) {
          // Override target agents with the delegating agent
          delegationOverrideAgent = delegationCompletionResult.targetAgent;
        }
        if (delegationCompletionResult.replyTarget) {
          logInfo(
            chalk.cyan(
              `Delegation completion will reply to original user event: ${delegationCompletionResult.replyTarget.id?.substring(0, 8)}`
            )
          );
          // Override the triggering event to be the original user request
          delegationOverrideEvent = delegationCompletionResult.replyTarget;
        }
      } else if (hasCompletionMarker) {
        // It was an explicit completion but shouldn't reactivate yet (waiting for more delegations)
        return;
      }
      // If it wasn't a delegation completion at all, continue normal processing
    }
  }

  // If delegation completion overrode the target, use that single agent
  if (delegationOverrideAgent) {
    targetAgents = [delegationOverrideAgent];
  }
  
  // If delegation completion overrode the event, use that
  const effectiveEvent = delegationOverrideEvent || event;

  // 6. Extract claude-session
  const claudeSessionId = mappedClaudeSessionId || AgentEventDecoder.getClaudeSessionId(effectiveEvent);
  if (claudeSessionId) {
    logInfo(
      chalk.gray("Passing claude-session to execution context: ") +
        chalk.cyan(claudeSessionId) +
        (mappedClaudeSessionId ? chalk.gray(" (from task mapping)") : "")
    );
  }

  // 7. Execute each target agent in parallel
  const executionPromises = targetAgents.map(async (targetAgent) => {
    // Build execution context for this agent
    const executionContext: ExecutionContext = {
      agent: targetAgent,
      conversationId: conversation.id,
      phase: conversation.phase,
      projectPath: process.cwd(),
      triggeringEvent: effectiveEvent,
      conversationCoordinator,
      claudeSessionId,
      isDelegationCompletion: isDelegationCompletionReactivation,
    };

    // Execute agent
    await executeAgent(
      executionContext,
      agentExecutor,
      conversation,
      conversationCoordinator,
      projectManager,
      effectiveEvent
    );
  });
  
  // Wait for all agents to complete
  await Promise.all(executionPromises);
}
