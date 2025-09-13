import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import type { ConversationCoordinator } from "../conversations";
import { getProjectContext } from "../services";
import { formatAnyError } from "../utils/error-formatter";
import { logger } from "../utils/logger";


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

    // Check for p-tags to determine if user @mentioned a specific agent
    const pTags = event.tags.filter((tag) => tag[0] === "p");
    const mentionedPubkeys = pTags
      .map((tag) => tag[1])
      .filter((pubkey): pubkey is string => !!pubkey);

    let targetAgent = null;

    // If there are p-tags, check if any match system agents
    if (mentionedPubkeys.length > 0) {
      for (const pubkey of mentionedPubkeys) {
        const agent = Array.from(projectCtx.agents.values()).find((a) => a.pubkey === pubkey);
        if (agent) {
          targetAgent = agent;
          break;
        }
      }
    }

    // If no p-tags or no matching agent, just log and return
    if (!targetAgent) {
      logger.info(chalk.gray(`New conversation without p-tags or matching agents - not routing to any agent`));
      return;
    }

    // Execute with the appropriate agent
    await context.agentExecutor.execute({
      agent: targetAgent,
      conversationId: conversation.id,
      projectPath: process.cwd(),
      triggeringEvent: event,
      conversationCoordinator: context.conversationCoordinator,
    });

    logger.info(chalk.green("✅ Conversation routed successfully"));
  } catch (error) {
    logger.info(chalk.red(`❌ Failed to route conversation: ${formatAnyError(error)}`));
  }
};
