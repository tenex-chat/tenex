import { getAgentSlugFromEvent, isEventFromUser } from "@/nostr/utils";
import { getProjectContext } from "@/services";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { type LlmRole, Message } from "multi-llm-ts";
import { MessageBuilder } from "./MessageBuilder";
import type { Phase } from "./phases";

/**
 * Manages the complete message stream for a specific agent in a conversation.
 * Single Responsibility: Build and maintain the message array for an agent<>conversation pair.
 */
export class AgentConversationContext {
  private messages: Message[] = [];
  private processedEventIds: Set<string> = new Set(); // Track processed events
  private lastProcessedIndex = 0;
  private claudeSessionId?: string;
  private currentPhase?: Phase;
  private messageBuilder: MessageBuilder;

  constructor(
    private conversationId: string,
    private agentSlug: string,
    messageBuilder?: MessageBuilder
  ) {
    this.messageBuilder = messageBuilder || new MessageBuilder();
  }

  /**
   * Process and add an NDKEvent to the message stream
   */
  async addEvent(event: NDKEvent): Promise<void> {
    if (!event.content) return;

    // Check if we've already processed this event
    if (event.id && this.processedEventIds.has(event.id)) {
      logger.debug(`[AGENT_CONTEXT] Skipping already processed event for ${this.agentSlug}`, {
        eventId: event.id,
        processedCount: this.processedEventIds.size,
      });
      return;
    }

    const processed = await this.messageBuilder.processNostrEntities(event.content);
    const message = this.messageBuilder.formatEventAsMessage(event, processed, this.agentSlug);

    this.messages.push(message);

    // Mark this event as processed
    if (event.id) {
      this.processedEventIds.add(event.id);
    }

    logger.debug(`[AGENT_CONTEXT] Added event to ${this.agentSlug}`, {
      eventId: event.id,
      messageType: message.role,
    });
  }

  /**
   * Handle phase transition if needed
   */
  handlePhaseTransition(newPhase: Phase, phaseInstructions?: string): boolean {
    // Only add phase instructions if we're actually transitioning
    // or if this is the first time seeing a phase
    if (this.currentPhase === newPhase) {
      return false; // No transition needed
    }

    const transitionMessage =
      phaseInstructions ||
      this.messageBuilder.buildPhaseTransitionMessage(this.currentPhase, newPhase);

    this.messages.push(new Message("system", transitionMessage));

    logger.info(`[AGENT_CONTEXT] Phase transition for ${this.agentSlug}`, {
      from: this.currentPhase,
      to: newPhase,
    });

    this.currentPhase = newPhase;
    return true; // Transition occurred
  }

  /**
   * Add the triggering event (the main event being responded to)
   */
  async addTriggeringEvent(event: NDKEvent): Promise<void> {
    if (!event.content) return;

    // Check if we've already processed this triggering event
    if (event.id && this.processedEventIds.has(event.id)) {
      logger.debug(
        `[AGENT_CONTEXT] Skipping already processed triggering event for ${this.agentSlug}`,
        {
          eventId: event.id,
          processedCount: this.processedEventIds.size,
        }
      );
      return;
    }

    // Process the content
    const processed = await this.messageBuilder.processNostrEntities(event.content);
    const message = this.messageBuilder.formatEventAsMessage(event, processed, this.agentSlug);

    // Update session ID if present
    const sessionId = event.tagValue?.("claude-session");
    if (sessionId) {
      this.claudeSessionId = sessionId;
      logger.debug(`[AGENT_CONTEXT] Updated Claude session for ${this.agentSlug}`, {
        sessionId,
      });
    }

    this.messages.push(message);

    // Mark this event as processed
    if (event.id) {
      this.processedEventIds.add(event.id);
    }
  }

  /**
   * Process multiple events at once (for catching up)
   */
  async addEvents(events: NDKEvent[], skipEventId?: string): Promise<void> {
    for (const event of events) {
      if (event.id === skipEventId) continue;
      if (!event.content) continue;
      await this.addEvent(event);
    }
  }

  /**
   * Add "messages while you were away" block
   */
  async addMissedMessages(events: NDKEvent[], handoffSummary?: string): Promise<void> {
    if (events.length === 0) return;

    let contextBlock = "=== MESSAGES WHILE YOU WERE AWAY ===\n\n";

    if (handoffSummary) {
      contextBlock += `**Previous context**: ${handoffSummary}\n\n`;
    }

    for (const event of events) {
      const sender = this.getEventSender(event);
      if (sender) {
        const processed = await this.messageBuilder.processNostrEntities(event.content);
        contextBlock += `${sender}:\n${processed}\n\n`;
      }
    }

    contextBlock += "=== END OF HISTORY ===\n";
    contextBlock += "Respond to the most recent user message above, considering the context.\n\n";

    this.messages.push(new Message("system", contextBlock));

    logger.debug(`[AGENT_CONTEXT] Added missed messages block for ${this.agentSlug}`, {
      eventCount: events.length,
    });
  }

  /**
   * Handle delegation responses
   */
  addDelegationResponses(responses: Map<string, NDKEvent>, originalRequest: string): void {
    let message = "=== DELEGATE RESPONSES RECEIVED ===\n\n";
    message += `You previously delegated the following request to ${responses.size} agent(s):\n`;
    message += `"${originalRequest}"\n\n`;
    message += "Here are all the responses:\n\n";

    for (const [pubkey, event] of responses) {
      const agentName = this.getAgentNameByPubkey(pubkey);
      message += `### Response from ${agentName}:\n`;
      message += `${event.content}\n\n`;
    }

    message += "=== END OF DELEGATE RESPONSES ===\n\n";
    message += "Now process these responses and complete your task.";

    this.messages.push(new Message("system", message));

    logger.info(`[AGENT_CONTEXT] Added delegation responses for ${this.agentSlug}`, {
      responseCount: responses.size,
    });
  }

  /**
   * Add a raw message (for special cases)
   */
  addMessage(message: Message): void {
    this.messages.push(message);
  }

  /**
   * Add multiple raw messages
   */
  addMessages(messages: Message[]): void {
    this.messages.push(...messages);
  }

  /**
   * Get all messages for this agent
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Get the last N messages
   */
  getRecentMessages(count: number): Message[] {
    return this.messages.slice(-count);
  }

  /**
   * Clear processed event IDs to allow rebuilding full conversation history
   * This is essential for agents to see their own previous responses
   */
  clearProcessedEvents(): void {
    this.processedEventIds.clear();
    this.messages = [];
  }

  /**
   * Remove the last message (useful for error recovery)
   */
  popMessage(): Message | undefined {
    return this.messages.pop();
  }

  /**
   * Get/set the Claude session ID
   */
  getClaudeSessionId(): string | undefined {
    return this.claudeSessionId;
  }

  setClaudeSessionId(sessionId: string): void {
    this.claudeSessionId = sessionId;
  }

  /**
   * Get/set the last processed index
   */
  getLastProcessedIndex(): number {
    return this.lastProcessedIndex;
  }

  setLastProcessedIndex(index: number): void {
    this.lastProcessedIndex = index;
  }

  /**
   * Get the current phase
   */
  getCurrentPhase(): Phase | undefined {
    return this.currentPhase;
  }

  /**
   * Set the current phase (without adding a message)
   */
  setCurrentPhase(phase: Phase): void {
    this.currentPhase = phase;
  }

  /**
   * Serialize for persistence
   */
  toJSON(): object {
    return {
      conversationId: this.conversationId,
      agentSlug: this.agentSlug,
      messages: this.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      processedEventIds: Array.from(this.processedEventIds),
      lastProcessedIndex: this.lastProcessedIndex,
      claudeSessionId: this.claudeSessionId,
      currentPhase: this.currentPhase,
    };
  }

  /**
   * Restore from persistence
   */
  static fromJSON(data: unknown, messageBuilder?: MessageBuilder): AgentConversationContext {
    // Type guard to ensure data is an object
    if (typeof data !== "object" || data === null) {
      throw new Error("Invalid data format for AgentConversationContext");
    }

    const jsonData = data as {
      conversationId: string;
      agentSlug: string;
      messages?: unknown[];
      processedEventIds?: string[];
      lastProcessedIndex?: number;
      claudeSessionId?: string;
      currentPhase?: string;
    };

    const context = new AgentConversationContext(
      jsonData.conversationId,
      jsonData.agentSlug,
      messageBuilder
    );

    // Restore messages
    if (jsonData.messages && Array.isArray(jsonData.messages)) {
      context.messages = jsonData.messages.map((m: unknown) => {
        if (typeof m === "object" && m !== null && "role" in m && "content" in m) {
          const msg = m as { role: string; content: string };
          return new Message(msg.role as LlmRole, msg.content);
        }
        throw new Error("Invalid message format in data");
      });
    }

    // Restore processed event IDs
    if (jsonData.processedEventIds && Array.isArray(jsonData.processedEventIds)) {
      context.processedEventIds = new Set(jsonData.processedEventIds);
    }

    context.lastProcessedIndex = jsonData.lastProcessedIndex || 0;
    context.claudeSessionId = jsonData.claudeSessionId;
    context.currentPhase = jsonData.currentPhase as Phase | undefined;

    return context;
  }

  /**
   * Helper to determine event sender
   */
  private getEventSender(event: NDKEvent): string | null {
    const eventAgentSlug = getAgentSlugFromEvent(event);

    if (isEventFromUser(event)) {
      return "🟢 USER";
    }
    if (eventAgentSlug) {
      const projectCtx = getProjectContext();
      const sendingAgent = projectCtx.agents.get(eventAgentSlug);
      const agentName = sendingAgent ? sendingAgent.name : "Another agent";

      // Mark the agent's own previous messages clearly
      if (eventAgentSlug === this.agentSlug) {
        return `💬 You (${agentName})`;
      }
      return `💬 ${agentName}`;
    }
    return "💬 Unknown";
  }

  /**
   * Helper to get agent name by pubkey
   */
  private getAgentNameByPubkey(pubkey: string): string {
    const projectCtx = getProjectContext();
    const agent = projectCtx.getAgentByPubkey(pubkey);
    return agent?.name || pubkey.substring(0, 8);
  }
}
