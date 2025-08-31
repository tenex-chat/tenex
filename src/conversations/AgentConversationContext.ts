import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { CoreMessage } from "ai";
import { MessageBuilder } from "./MessageBuilder";
import type { AgentState, Conversation } from "./types";

/**
 * Orchestrates message building for a specific agent in a conversation.
 * Single Responsibility: Coordinate the selection and ordering of messages for an agent.
 * This is now a STATELESS component that builds messages on-demand.
 */
export class AgentConversationContext {
  constructor(
    private conversationId: string,
    private agentSlug: string
  ) {}

  /**
   * Build messages from conversation history for this agent
   * This is now a pure function that doesn't maintain state
   */
  async buildMessages(
    conversation: Conversation,
    agentState: AgentState,
    triggeringEvent?: NDKEvent,
    phaseInstructions?: string
  ): Promise<CoreMessage[]> {
    const messages: CoreMessage[] = [];

    // Process history up to (but not including) the triggering event
    for (const event of conversation.history) {
      if (!event.content) continue;
      if (triggeringEvent?.id && event.id === triggeringEvent.id) {
        break; // Don't include the triggering event in history
      }

      const processed = await MessageBuilder.processNostrEntities(event.content);
      const message = await MessageBuilder.formatEventAsMessage(
        event, 
        processed, 
        this.agentSlug, 
        this.conversationId
      );
      messages.push(message);
    }

    // Add phase transition message if needed
    if (phaseInstructions) {
      const phaseMessage = MessageBuilder.buildPhaseTransitionMessage(
        agentState.lastSeenPhase,
        conversation.phase
      );
      messages.push({ role: "system", content: phaseMessage + "\n\n" + phaseInstructions });
    }

    // Add the triggering event last
    if (triggeringEvent && triggeringEvent.content) {
      const processed = await MessageBuilder.processNostrEntities(triggeringEvent.content);
      const message = await MessageBuilder.formatEventAsMessage(
        triggeringEvent,
        processed,
        this.agentSlug,
        this.conversationId
      );
      messages.push(message);
    }

    logger.debug(`[AGENT_CONTEXT] Built ${messages.length} messages for ${this.agentSlug}`, {
      conversationId: this.conversationId,
      hasPhaseInstructions: !!phaseInstructions,
      hasTriggeringEvent: !!triggeringEvent,
    });

    return messages;
  }

  /**
   * Build messages with missed conversation history
   * Used when an agent needs to catch up on messages they missed
   */
  async buildMessagesWithMissedHistory(
    conversation: Conversation,
    agentState: AgentState,
    missedEvents: NDKEvent[],
    delegationSummary?: string,
    triggeringEvent?: NDKEvent,
    phaseInstructions?: string
  ): Promise<CoreMessage[]> {
    const messages: CoreMessage[] = [];

    // Add missed messages block if there are any
    if (missedEvents.length > 0) {
      const missedBlock = await MessageBuilder.buildMissedMessagesBlock(
        missedEvents,
        this.agentSlug,
        delegationSummary
      );
      messages.push(missedBlock);
    }

    // Add phase transition if needed
    if (phaseInstructions) {
      const phaseMessage = MessageBuilder.buildPhaseTransitionMessage(
        agentState.lastSeenPhase,
        conversation.phase
      );
      messages.push({ role: "system", content: phaseMessage + "\n\n" + phaseInstructions });
    }

    // Add triggering event
    if (triggeringEvent && triggeringEvent.content) {
      const processed = await MessageBuilder.processNostrEntities(triggeringEvent.content);
      const message = await MessageBuilder.formatEventAsMessage(
        triggeringEvent,
        processed,
        this.agentSlug,
        this.conversationId
      );
      messages.push(message);
    }

    return messages;
  }

  /**
   * Build messages with delegation responses
   */
  buildMessagesWithDelegationResponses(
    responses: Map<string, NDKEvent>,
    originalRequest: string,
    conversation: Conversation,
    agentState: AgentState,
    triggeringEvent?: NDKEvent,
    phaseInstructions?: string
  ): CoreMessage[] {
    const messages: CoreMessage[] = [];

    // Add the delegation responses block
    const delegationBlock = MessageBuilder.buildDelegationResponsesBlock(
      responses,
      originalRequest
    );
    messages.push(delegationBlock);

    // Add phase transition if needed  
    if (phaseInstructions) {
      const phaseMessage = MessageBuilder.buildPhaseTransitionMessage(
        agentState.lastSeenPhase,
        conversation.phase
      );
      messages.push({ role: "system", content: phaseMessage + "\n\n" + phaseInstructions });
    }

    // Note: Triggering event would typically already be in the delegation responses
    // but we can add it if needed for context
    if (triggeringEvent && triggeringEvent.content) {
      logger.debug("[AGENT_CONTEXT] Adding triggering event after delegation responses", {
        eventId: triggeringEvent.id,
      });
    }

    return messages;
  }

  /**
   * Extract session ID from an event (utility method)
   */
  extractSessionId(event: NDKEvent): string | undefined {
    return event.tagValue?.("claude-session");
  }



}
