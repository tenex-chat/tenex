import type { AgentInstance } from "@/agents/types";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";
import { AgentConversationContext } from "../AgentConversationContext";
import { buildPhaseInstructions } from "@/prompts/utils/systemPromptBuilder";
import { ensureExecutionTimeInitialized } from "../executionTime";
import { FileSystemAdapter } from "../persistence";
import type { ConversationPersistenceAdapter } from "../persistence/types";
import type { Phase, AgentState, Conversation, ConversationMetadata } from "../types";
import { ConversationEventProcessor } from "./ConversationEventProcessor";
import { ConversationPersistenceService, type IConversationPersistenceService } from "./ConversationPersistenceService";
import { ConversationStore } from "./ConversationStore";

/**
 * Coordinates between all conversation services.
 * Single Responsibility: Orchestrate calls to specialized services.
 */
export class ConversationCoordinator {
  private store: ConversationStore;
  private persistence: IConversationPersistenceService;
  private eventProcessor: ConversationEventProcessor;
  

  constructor(
    projectPath: string,
    persistence?: ConversationPersistenceAdapter
  ) {
    // Create services
    this.store = new ConversationStore();
    this.persistence = new ConversationPersistenceService(
      persistence || new FileSystemAdapter(projectPath)
    );
    this.eventProcessor = new ConversationEventProcessor();
  }

  /**
   * Initialize the coordinator
   */
  async initialize(): Promise<void> {
    await this.persistence.initialize();
    await this.loadConversations();
  }

  /**
   * Create a new conversation from an event
   */
  async createConversation(event: NDKEvent): Promise<Conversation> {
    const conversation = await this.eventProcessor.createConversationFromEvent(event);

    // Log conversation start
    logger.info(
      `Starting conversation ${conversation.id.substring(0, 8)} - "${event.content?.substring(0, 50)}..."`
    );

    // Store and persist
    this.store.set(conversation.id, conversation);
    await this.persistence.save(conversation);

    return conversation;
  }

  /**
   * Get a conversation by ID
   */
  getConversation(id: string): Conversation | undefined {
    return this.store.get(id);
  }

  /**
   * Check if a conversation exists
   */
  hasConversation(id: string): boolean {
    return this.store.has(id);
  }

  /**
   * Set the title of a conversation
   */
  setTitle(conversationId: string, title: string): void {
    const conversation = this.store.get(conversationId);
    if (conversation) {
      conversation.title = title;
      // Note: Not persisting immediately to avoid race conditions
      // Will be persisted on next save operation
    }
  }

  /**
   * Get a conversation by event ID
   */
  getConversationByEvent(eventId: string): Conversation | undefined {
    return this.store.findByEvent(eventId);
  }

  /**
   * Get all conversations
   */
  getAllConversations(): Conversation[] {
    return this.store.getAll();
  }

  /**
   * Add an event to a conversation
   */
  async addEvent(conversationId: string, event: NDKEvent): Promise<void> {
    const conversation = this.store.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    this.eventProcessor.processIncomingEvent(conversation, event);
    await this.persistence.save(conversation);
  }

  /**
   * Update conversation metadata
   */
  async updateMetadata(
    conversationId: string,
    metadata: Partial<ConversationMetadata>
  ): Promise<void> {
    const conversation = this.store.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    this.eventProcessor.updateMetadata(conversation, metadata);
    await this.persistence.save(conversation);
  }


  /**
   * Build messages for an agent
   */
  async buildAgentMessages(
    conversationId: string,
    targetAgent: AgentInstance,
    triggeringEvent?: NDKEvent
  ): Promise<{ messages: ModelMessage[] }> {
    const conversation = this.store.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // Create a stateless agent context on-demand
    const context = new AgentConversationContext(conversationId, targetAgent.slug, targetAgent.pubkey);

    // Get or initialize the agent's state
    let agentState = conversation.agentStates.get(targetAgent.slug);
    if (!agentState) {
      agentState = {
        lastProcessedMessageIndex: 0,
      };
      conversation.agentStates.set(targetAgent.slug, agentState);
    }

    // Phase instructions are now handled transiently via event tags
    let phaseInstructions: string | undefined;

    // Build messages using the stateless context
    const messages = await context.buildMessages(
      conversation,
      agentState,
      triggeringEvent,
      phaseInstructions
    );

    // Update agent state
    agentState.lastProcessedMessageIndex = conversation.history.length;

    await this.persistence.save(conversation);

    return {
      messages,
    };
  }

  /**
   * Update an agent's state
   */
  async updateAgentState(
    conversationId: string,
    agentSlug: string,
    updates: Partial<AgentState>
  ): Promise<void> {
    const conversation = this.store.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    let agentState = conversation.agentStates.get(agentSlug);
    if (!agentState) {
      agentState = {
        lastProcessedMessageIndex: 0,
      };
      conversation.agentStates.set(agentSlug, agentState);
    }

    Object.assign(agentState, updates);
    await this.persistence.save(conversation);
  }

  /**
   * Archive a conversation
   */
  async archiveConversation(conversationId: string): Promise<void> {
    await this.persistence.archive(conversationId);
    this.store.delete(conversationId);
  }

  /**
   * Search conversations
   */
  async searchConversations(query: string): Promise<Conversation[]> {
    return await this.persistence.search({ title: query });
  }

  /**
   * Clean up and save all conversations
   */
  async cleanup(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const conversation of this.store.getAll()) {
      promises.push(this.persistence.save(conversation));
    }
    await Promise.all(promises);
  }

  /**
   * Complete a conversation
   */
  async completeConversation(conversationId: string): Promise<void> {
    const conversation = this.store.get(conversationId);
    if (!conversation) {
      return;
    }

    this.eventProcessor.cleanupMetadata(conversation);
    this.store.delete(conversationId);

    await this.persistence.save(conversation);
  }


  /**
   * Get phase history for a conversation
   */
  getPhaseHistory(conversationId: string): NDKEvent[] {
    const conversation = this.store.get(conversationId);
    return conversation?.history || [];
  }


  /**
   * Clean up conversation metadata
   */
  cleanupConversationMetadata(conversationId: string): void {
    const conversation = this.store.get(conversationId);
    if (conversation) {
      this.eventProcessor.cleanupMetadata(conversation);
    }
  }

  // Private helper methods

  private async loadConversations(): Promise<void> {
    try {
      const conversations = await this.persistence.loadAll();

      for (const conversation of conversations) {
        ensureExecutionTimeInitialized(conversation);

        // Ensure agentStates is a Map
        if (!(conversation.agentStates instanceof Map)) {
          const statesObj = conversation.agentStates as Record<string, AgentState>;
          conversation.agentStates = new Map(Object.entries(statesObj || {}));
        }

        this.store.set(conversation.id, conversation);
      }
    } catch (error) {
      logger.error("[ConversationCoordinator] Failed to load conversations", { error });
    }
  }





}
