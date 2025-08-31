import type { AgentInstance } from "@/agents/types";
import { logger, logInfo } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Message } from "multi-llm-ts";
import { AgentConversationContext } from "../AgentConversationContext";
import { MessageBuilder } from "../MessageBuilder";
import { ensureExecutionTimeInitialized } from "../executionTime";
import { FileSystemAdapter } from "../persistence";
import type { ConversationPersistenceAdapter } from "../persistence/types";
import type { Phase } from "../phases";
import { PHASES } from "../phases";
import type { AgentState, Conversation, ConversationMetadata, PhaseTransition } from "../types";
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
  
  // Simple execution lock - only one conversation can execute at a time
  private currentlyExecuting: string | null = null;
  private executionQueue: Array<{conversationId: string; agentPubkey: string}> = [];

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
    logInfo(
      `Starting conversation ${conversation.id.substring(0, 8)}`,
      "conversation",
      "normal",
      {
        conversationId: conversation.id,
        userMessage: event.content?.substring(0, 100),
        eventId: event.id,
      }
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
    const conversation = this.store.get(id);
    
    // Debug logging to trace session usage
    if (conversation?.agentStates) {
      for (const [agentSlug, state] of conversation.agentStates.entries()) {
        if (state.claudeSessionsByPhase) {
          logger.debug(`[ConversationCoordinator] Conversation ${id.substring(0, 8)} has sessions for agent ${agentSlug}:`, {
            conversationId: id,
            agentSlug,
            sessions: state.claudeSessionsByPhase,
          });
        }
      }
    }
    
    return conversation;
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
   * Update conversation phase
   */
  async updatePhase(
    id: string,
    phase: Phase,
    message: string,
    agentPubkey: string,
    agentName: string
  ): Promise<boolean> {
    const conversation = this.store.get(id);
    if (!conversation) {
      throw new Error(`Conversation ${id} not found`);
    }

    const from = conversation.phase;

    // Handle EXECUTE phase entry with simple lock
    if (phase === PHASES.EXECUTE && from !== PHASES.EXECUTE) {
      const canExecute = await this.requestExecution(conversation.id, agentPubkey);
      
      if (!canExecute) {
        // Already queued, return false to prevent phase transition
        return false;
      }
    }

    // Handle EXECUTE phase exit
    if (from === PHASES.EXECUTE && phase !== PHASES.EXECUTE) {
      await this.releaseExecution(conversation.id);
    }

    // Create transition record
    const transition: PhaseTransition = {
      from,
      to: phase,
      message,
      timestamp: Date.now(),
      agentPubkey,
      agentName,
    };

    // Update conversation
    if (from !== phase) {
      conversation.phase = phase;
      conversation.phaseStartedAt = Date.now();

      // Clear readFiles when transitioning from REFLECTION back to CHAT
      if (from === PHASES.REFLECTION && phase === PHASES.CHAT) {
        conversation.metadata.readFiles = undefined;
      }
    }

    conversation.phaseTransitions.push(transition);

    logInfo(
      `Phase transition: ${from} → ${phase}`,
      "conversation",
      "verbose",
      {
        conversationId: id,
        from,
        to: phase,
      }
    );

    await this.persistence.save(conversation);
    return true;
  }

  /**
   * Build messages for an agent
   */
  async buildAgentMessages(
    conversationId: string,
    targetAgent: AgentInstance,
    triggeringEvent?: NDKEvent
  ): Promise<{ messages: Message[]; claudeSessionId?: string }> {
    const conversation = this.store.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // Create a stateless agent context on-demand
    const context = new AgentConversationContext(conversationId, targetAgent.slug);

    // Get or initialize the agent's state
    let agentState = conversation.agentStates.get(targetAgent.slug);
    if (!agentState) {
      agentState = {
        lastProcessedMessageIndex: 0,
        lastSeenPhase: undefined,
      };
      conversation.agentStates.set(targetAgent.slug, agentState);
    }

    // Check if we need phase instructions
    const needsPhaseInstructions = !agentState.lastSeenPhase || agentState.lastSeenPhase !== conversation.phase;
    let phaseInstructions: string | undefined;
    
    if (needsPhaseInstructions) {
      const instructions = MessageBuilder.buildPhaseInstructions(conversation.phase, conversation);
      if (agentState.lastSeenPhase) {
        phaseInstructions = MessageBuilder.formatPhaseTransitionMessage(
          agentState.lastSeenPhase,
          conversation.phase,
          instructions
        );
      } else {
        phaseInstructions = `=== CURRENT PHASE: ${conversation.phase.toUpperCase()} ===\n\n${instructions}`;
      }
      agentState.lastSeenPhase = conversation.phase;
    }

    // Build messages using the stateless context
    const messages = await context.buildMessages(
      conversation,
      agentState,
      triggeringEvent,
      phaseInstructions
    );

    // Update agent state
    agentState.lastProcessedMessageIndex = conversation.history.length;

    // Extract and update session ID if present in triggering event
    if (triggeringEvent) {
      const sessionId = context.extractSessionId(triggeringEvent);
      if (sessionId && conversation.phase) {
        if (!agentState.claudeSessionsByPhase) {
          agentState.claudeSessionsByPhase = {} as Record<Phase, string>;
        }
        agentState.claudeSessionsByPhase[conversation.phase] = sessionId;
      }
    }

    await this.persistence.save(conversation);

    return {
      messages,
      claudeSessionId: conversation.phase && agentState.claudeSessionsByPhase?.[conversation.phase],
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
        lastSeenPhase: undefined,
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
   * Request execution lock for a conversation
   */
  private async requestExecution(conversationId: string, agentPubkey: string): Promise<boolean> {
    // If already executing this conversation, allow it
    if (this.currentlyExecuting === conversationId) {
      return true;
    }
    
    // If nothing is executing, take the lock
    if (!this.currentlyExecuting) {
      this.currentlyExecuting = conversationId;
      logger.info(`[ConversationCoordinator] Execution lock acquired for ${conversationId}`);
      return true;
    }
    
    // Check if already in queue
    const existingIndex = this.executionQueue.findIndex(e => e.conversationId === conversationId);
    if (existingIndex >= 0) {
      return false; // Already queued
    }
    
    // Add to queue
    this.executionQueue.push({ conversationId, agentPubkey });
    const position = this.executionQueue.length;
    
    logger.info(`[ConversationCoordinator] Conversation ${conversationId} queued at position ${position}`);
    
    // Update conversation with queue status
    const conversation = this.store.get(conversationId);
    if (conversation) {
      conversation.metadata.queueStatus = {
        isQueued: true,
        position,
        message: this.formatQueueMessage(position),
      };
      await this.persistence.save(conversation);
    }
    
    return false;
  }
  
  /**
   * Release execution lock
   */
  private async releaseExecution(conversationId: string): Promise<void> {
    if (this.currentlyExecuting !== conversationId) {
      return; // Not holding the lock
    }
    
    logger.info(`[ConversationCoordinator] Releasing execution lock for ${conversationId}`);
    this.currentlyExecuting = null;
    
    // Process next in queue
    await this.processNextInQueue();
  }
  
  /**
   * Process next conversation in queue
   */
  private async processNextInQueue(): Promise<void> {
    if (this.executionQueue.length === 0) {
      return; // Queue is empty
    }
    
    const next = this.executionQueue.shift();
    if (!next) return;
    
    // Grant execution to next conversation
    this.currentlyExecuting = next.conversationId;
    
    // Clear queue status from conversation
    const conversation = this.store.get(next.conversationId);
    if (conversation) {
      conversation.metadata.queueStatus = undefined;
      await this.persistence.save(conversation);
      
      logger.info(`[ConversationCoordinator] Execution lock granted to ${next.conversationId} from queue`);
      
      // The conversation will naturally progress to EXECUTE phase
      // when it's next processed
    }
  }
  
  /**
   * Force release the current execution lock
   */
  async forceReleaseExecution(): Promise<string | null> {
    if (!this.currentlyExecuting) {
      return null;
    }
    
    const released = this.currentlyExecuting;
    logger.info(`[ConversationCoordinator] Force releasing execution lock for ${released}`);
    
    this.currentlyExecuting = null;
    await this.processNextInQueue();
    
    return released;
  }
  
  /**
   * Get execution status
   */
  getExecutionStatus(): { active: string | null; queued: string[] } {
    return {
      active: this.currentlyExecuting,
      queued: this.executionQueue.map(e => e.conversationId),
    };
  }
  
  /**
   * Remove conversation from queue
   */
  async removeFromQueue(conversationId: string): Promise<boolean> {
    const initialLength = this.executionQueue.length;
    this.executionQueue = this.executionQueue.filter(e => e.conversationId !== conversationId);
    
    if (this.executionQueue.length !== initialLength) {
      // Update positions for remaining queued conversations
      for (let i = 0; i < this.executionQueue.length; i++) {
        const conv = this.store.get(this.executionQueue[i].conversationId);
        if (conv?.metadata.queueStatus) {
          conv.metadata.queueStatus.position = i + 1;
          conv.metadata.queueStatus.message = this.formatQueueMessage(i + 1);
          await this.persistence.save(conv);
        }
      }
      return true;
    }
    
    return false;
  }
  
  /**
   * Clear all queued conversations
   */
  async clearQueue(): Promise<void> {
    // Clear queue status from all queued conversations
    for (const entry of this.executionQueue) {
      const conversation = this.store.get(entry.conversationId);
      if (conversation) {
        conversation.metadata.queueStatus = undefined;
        await this.persistence.save(conversation);
      }
    }
    
    this.executionQueue = [];
    logger.info("[ConversationCoordinator] Execution queue cleared");
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




  private formatQueueMessage(position: number): string {
    return `🚦 Execution Queue Status\n\nYour conversation has been added to the execution queue.\n\nQueue Position: ${position}\n\nYou will be automatically notified when execution begins.`;
  }

}
