import { logger } from "@/utils/logger";
import type { Conversation } from "../types";

/**
 * In-memory storage for active conversations.
 * Single Responsibility: Fast lookup and retrieval of conversation objects.
 */
export class ConversationStore {
  private conversations: Map<string, Conversation> = new Map();

  /**
   * Get a conversation by ID
   */
  get(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  /**
   * Store a conversation
   */
  set(id: string, conversation: Conversation): void {
    // Debug logging for session tracking
    if (conversation.agentStates) {
      for (const [agentSlug, state] of conversation.agentStates.entries()) {
        if (state.claudeSessionsByPhase) {
          logger.debug(`[ConversationStore] Storing conversation ${id.substring(0, 8)} with existing sessions for agent ${agentSlug}:`, {
            conversationId: id,
            agentSlug,
            sessions: state.claudeSessionsByPhase,
          });
        }
      }
    }
    
    this.conversations.set(id, conversation);
    logger.debug(`[ConversationStore] Stored conversation ${id}`);
  }

  /**
   * Delete a conversation
   */
  delete(id: string): void {
    this.conversations.delete(id);
    logger.debug(`[ConversationStore] Deleted conversation ${id}`);
  }

  /**
   * Check if a conversation exists
   */
  exists(id: string): boolean {
    return this.conversations.has(id);
  }

  /**
   * Get all conversations
   */
  getAll(): Conversation[] {
    return Array.from(this.conversations.values());
  }

  /**
   * Find a conversation by event ID
   */
  findByEvent(eventId: string): Conversation | undefined {
    for (const conversation of this.conversations.values()) {
      if (conversation.history.some((e) => e.id === eventId)) {
        return conversation;
      }
    }
    return undefined;
  }

  /**
   * Clear all conversations
   */
  clear(): void {
    this.conversations.clear();
    logger.debug("[ConversationStore] Cleared all conversations");
  }

  /**
   * Get the number of stored conversations
   */
  size(): number {
    return this.conversations.size;
  }
}
