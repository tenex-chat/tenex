import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";
import { NostrEntityProcessor } from "./processors/NostrEntityProcessor";
import { MessageRoleAssigner } from "./processors/MessageRoleAssigner";
import { DelegationFormatter } from "./processors/DelegationFormatter";
import type { AgentState, Conversation } from "./types";
import type { Phase } from "./phases";

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
  ): Promise<ModelMessage[]> {
    const messages: ModelMessage[] = [];

    // Process history up to (but not including) the triggering event
    for (const event of conversation.history) {
      if (!event.content) continue;
      if (triggeringEvent?.id && event.id === triggeringEvent.id) {
        break; // Don't include the triggering event in history
      }

      const processed = await NostrEntityProcessor.processEntities(event.content);
      const message = await MessageRoleAssigner.assignRole(
        event, 
        processed, 
        this.agentSlug, 
        this.conversationId
      );
      messages.push(message);
    }

    // Add phase transition message if needed
    if (phaseInstructions) {
      const phaseMessage = this.buildSimplePhaseTransitionMessage(
        agentState.lastSeenPhase,
        conversation.phase
      );
      messages.push({ role: "system", content: phaseMessage + "\n\n" + phaseInstructions });
    }

    // Add the triggering event last
    if (triggeringEvent && triggeringEvent.content) {
      const processed = await NostrEntityProcessor.processEntities(triggeringEvent.content);
      const message = await MessageRoleAssigner.assignRole(
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
  ): Promise<ModelMessage[]> {
    const messages: ModelMessage[] = [];

    // Add missed messages block if there are any
    if (missedEvents.length > 0) {
      const missedBlock = await DelegationFormatter.buildMissedMessagesBlock(
        missedEvents,
        this.agentSlug,
        delegationSummary
      );
      messages.push(missedBlock);
    }

    // Add phase transition if needed
    if (phaseInstructions) {
      const phaseMessage = this.buildSimplePhaseTransitionMessage(
        agentState.lastSeenPhase,
        conversation.phase
      );
      messages.push({ role: "system", content: phaseMessage + "\n\n" + phaseInstructions });
    }

    // Add triggering event
    if (triggeringEvent && triggeringEvent.content) {
      const processed = await NostrEntityProcessor.processEntities(triggeringEvent.content);
      const message = await MessageRoleAssigner.assignRole(
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
  ): ModelMessage[] {
    const messages: ModelMessage[] = [];

    // Add the delegation responses block
    const delegationBlock = DelegationFormatter.buildDelegationResponsesBlock(
      responses,
      originalRequest
    );
    messages.push(delegationBlock);

    // Add phase transition if needed  
    if (phaseInstructions) {
      const phaseMessage = this.buildSimplePhaseTransitionMessage(
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

  /**
   * Build simple phase transition message (without instructions)
   * This is the simple format, different from the full transition with instructions
   */
  private buildSimplePhaseTransitionMessage(fromPhase: Phase | undefined, toPhase: Phase): string {
    if (fromPhase) {
      return `=== PHASE TRANSITION: ${fromPhase.toUpperCase()} → ${toPhase.toUpperCase()} ===`;
    }
    return `=== CURRENT PHASE: ${toPhase.toUpperCase()} ===`;
  }
}
