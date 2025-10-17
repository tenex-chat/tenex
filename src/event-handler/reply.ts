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
import { BrainstormService } from "../services/BrainstormService";


interface EventHandlerContext {
  conversationCoordinator: ConversationCoordinator;
  agentExecutor: AgentExecutor;
}

/**
 * Check if an event is a brainstorm event
 */
function isBrainstormEvent(event: NDKEvent): boolean {
  if (event.kind !== 11) return false;
  
  const modeTags = event.tags.filter(tag => tag[0] === "mode" && tag[1] === "brainstorm");
  return modeTags.length > 0;
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

  // 1. Check if this is a brainstorm follow-up BEFORE creating orphaned conversations
  // Check if the event references a kind:11 event
  const referencedKind = AgentEventDecoder.getReferencedKind(event);
  const conversationRoot = AgentEventDecoder.getConversationRoot(event);

  if (referencedKind === "11" && conversationRoot) {
    // Try to find the root event to check if it's a brainstorm
    const existingConversation = conversationCoordinator.getConversationByEvent(conversationRoot);

    if (existingConversation) {
      const rootEvent = existingConversation.history[0];
      if (rootEvent && isBrainstormEvent(rootEvent)) {
        logger.info("Detected brainstorm follow-up, delegating to BrainstormService", {
          eventId: event.id?.substring(0, 8),
          rootId: rootEvent.id?.substring(0, 8)
        });

        const brainstormService = new BrainstormService(projectCtx);
        await brainstormService.handleFollowUp(event);
        return;
      }
    } else {
      // The root event doesn't exist in our conversation history yet
      // This might be a reply to a brainstorm that we haven't seen the root for
      // Check if it has brainstorm participant tags
      const hasParticipantTags = event.tags.some(tag => tag[0] === "participant");
      const hasBrainstormModeTags = event.tags.some(tag => tag[0] === "mode" && tag[1] === "brainstorm");

      if (hasParticipantTags || hasBrainstormModeTags) {
        logger.info("Detected orphaned brainstorm follow-up, delegating to BrainstormService", {
          eventId: event.id?.substring(0, 8),
          conversationRoot
        });
        // Process through BrainstormService even without existing conversation
        const brainstormService = new BrainstormService(projectCtx);
        await brainstormService.handleFollowUp(event);
        return;
      }
    }
  }

  // 2. Continue with normal resolution if not a brainstorm follow-up
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

  // 4. Filter out self-replies (except for agents with delegate_phase tool)
  const nonSelfReplyAgents = AgentRouter.filterOutSelfReplies(event, targetAgents);

  // Check if any of the filtered agents have delegate_phase tool
  const selfReplyAgentsWithDelegatePhase = targetAgents.filter(agent => {
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
    const filteredAgents = targetAgents.filter(a => !nonSelfReplyAgents.includes(a));
    const allowedSelfReplies = filteredAgents.filter(a => a.tools?.includes("delegate_phase"));
    const blockedSelfReplies = filteredAgents.filter(a => !a.tools?.includes("delegate_phase"));

    if (allowedSelfReplies.length > 0) {
      logger.info(
        chalk.gray(
          `Allowing self-reply for agents with delegate_phase: ${allowedSelfReplies.map(a => a.name).join(", ")}`
        )
      );
    }

    if (blockedSelfReplies.length > 0) {
      logger.info(
        chalk.gray(
          `Filtered out self-reply for: ${blockedSelfReplies.map(a => a.name).join(", ")}`
        )
      );
    }
  }

  targetAgents = finalTargetAgents;

  // 5. Execute each target agent in parallel
  const executionPromises = targetAgents.map(async (targetAgent) => {
    // Build execution context for this agent
    const executionContext: ExecutionContext = {
      agent: targetAgent,
      conversationId: conversation.id,
      projectPath: projectCtx.agentRegistry.getBasePath(),
      triggeringEvent: event,
      conversationCoordinator,
      getConversation: () => conversationCoordinator.getConversation(conversation.id),
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
