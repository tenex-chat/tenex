import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import type { ConversationCoordinator } from "../conversations";
import { getProjectContext } from "../services";
import { formatAnyError } from "../utils/error-formatter";
import { logger } from "../utils/logger";
import { AgentRouter } from "./AgentRouter";
import { trace } from '@opentelemetry/api';
import { AgentEventDecoder } from "../nostr/AgentEventDecoder";


interface EventHandlerContext {
  conversationCoordinator: ConversationCoordinator;
  agentExecutor: AgentExecutor;
  projectPath: string;
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

    // Add telemetry for routing decision
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);
      activeSpan.addEvent('agent_routing', {
        'routing.mentioned_pubkeys_count': mentionedPubkeys.length,
        'routing.resolved_agent_count': targetAgents.length,
        'routing.agent_names': targetAgents.map(a => a.name).join(', '),
        'routing.agent_roles': targetAgents.map(a => a.role).join(', '),
      });
    }

    // If no valid agents found (filtered by project context), return
    if (targetAgents.length === 0) {
      logger.info(chalk.gray("New conversation - no valid agents to route to (may have been filtered by project context)"));
      if (activeSpan) {
        activeSpan.addEvent('agent_routing_failed', { 'reason': 'no_agents_resolved' });
      }
      return;
    }

    // Use first agent for kind 11 (new conversation)
    const targetAgent = targetAgents[0];

    // Execute with the appropriate agent
    await context.agentExecutor.execute({
      agent: targetAgent,
      conversationId: conversation.id,
      projectPath: context.projectPath,
      triggeringEvent: event,
      conversationCoordinator: context.conversationCoordinator,
      getConversation: () => context.conversationCoordinator.getConversation(conversation.id),
    });

    logger.info(chalk.green("✅ Conversation routed successfully"));
  } catch (error) {
    logger.info(chalk.red(`❌ Failed to route conversation: ${formatAnyError(error)}`));
  }
};
