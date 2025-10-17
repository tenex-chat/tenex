import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import type { ConversationCoordinator } from "../conversations";
import { getProjectContext } from "../services";
import { formatAnyError } from "../utils/error-formatter";
import { logger } from "../utils/logger";
import { AgentRouter } from "./AgentRouter";


interface EventHandlerContext {
  conversationCoordinator: ConversationCoordinator;
  agentExecutor: AgentExecutor;
}

export const handleNewConversation = async (
  event: NDKEvent,
  context: EventHandlerContext
): Promise<void> => {
  try {
    // Create conversation
    const conversation = await context.conversationCoordinator.createConversation(event);

    // Get project context
    const projectCtx = getProjectContext();

    // Use AgentRouter to resolve target agents (includes project validation for global agents)
    const targetAgents = AgentRouter.resolveTargetAgents(event, projectCtx);

    // If no valid agents found (filtered by project context), return
    if (targetAgents.length === 0) {
      logger.info(chalk.gray("New conversation - no valid agents to route to (may have been filtered by project context)"));
      return;
    }

    // Use first agent for kind 11 (new conversation)
    const targetAgent = targetAgents[0];

    // Execute with the appropriate agent
    await context.agentExecutor.execute({
      agent: targetAgent,
      conversationId: conversation.id,
      projectPath: process.cwd(),
      triggeringEvent: event,
      conversationCoordinator: context.conversationCoordinator,
      getConversation: () => context.conversationCoordinator.getConversation(conversation.id),
    });

    logger.info(chalk.green("✅ Conversation routed successfully"));
  } catch (error) {
    logger.info(chalk.red(`❌ Failed to route conversation: ${formatAnyError(error)}`));
  }
};
