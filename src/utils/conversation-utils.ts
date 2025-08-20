import type { ExecutionContext } from "@/agents/execution/types";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { logger } from "@/utils/logger";

/**
 * Gets the root conversation ID for a given context.
 * For delegated tasks, this returns the parent conversation ID.
 * For direct conversations, this returns the current conversation ID.
 */
export function getRootConversationId(context: ExecutionContext): string {
  // Check if this is a delegated task (kind 1934)
  if (context.triggeringEvent.kind === 1934) {
    const registry = DelegationRegistry.getInstance();
    const delegationContext = registry.getDelegationContext(context.triggeringEvent.id);

    if (delegationContext) {
      logger.debug("[getRootConversationId] Found delegation context, using parent conversation", {
        currentConversationId: context.conversationId.substring(0, 8),
        rootConversationId: delegationContext.delegatingAgent.conversationId.substring(0, 8),
        delegatingAgent: delegationContext.delegatingAgent.slug,
      });
      return delegationContext.delegatingAgent.conversationId;
    }
  }

  // Not a delegation or no delegation context found - use current conversation
  logger.debug("[getRootConversationId] Using current conversation as root", {
    conversationId: context.conversationId.substring(0, 8),
  });
  return context.conversationId;
}
