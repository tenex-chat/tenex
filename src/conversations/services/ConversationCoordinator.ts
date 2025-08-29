import type { AgentInstance } from "@/agents/types";
import { logger, logInfo } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Message } from "multi-llm-ts";
import { AgentConversationContext } from "../AgentConversationContext";
import { MessageBuilder } from "../MessageBuilder";
import type { ExecutionQueueManager } from "../executionQueue";
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
  private executionQueueManager?: ExecutionQueueManager;

  constructor(
    projectPath: string,
    persistence?: ConversationPersistenceAdapter,
    executionQueueManager?: ExecutionQueueManager
  ) {
    // Create services
    this.store = new ConversationStore();
    this.persistence = new ConversationPersistenceService(
      persistence || new FileSystemAdapter(projectPath)
    );
    this.eventProcessor = new ConversationEventProcessor();
    this.executionQueueManager = executionQueueManager;

    // Setup queue listeners if available
    if (executionQueueManager) {
      this.setupQueueListeners();
    }
  }

  /**
   * Initialize the coordinator
   */
  async initialize(): Promise<void> {
    await this.persistence.initialize();
    await this.loadConversations();
    logger.info("[ConversationCoordinator] Initialized");
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

    // Handle EXECUTE phase entry with queue management
    if (phase === PHASES.EXECUTE && from !== PHASES.EXECUTE && this.executionQueueManager) {
      const permission = await this.executionQueueManager.requestExecution(
        conversation.id,
        agentPubkey
      );

      if (!permission.granted) {
        if (!permission.queuePosition || !permission.waitTime) {
          throw new Error("Invalid permission - missing queue position or wait time");
        }
        
        const queueMessage = this.formatQueueMessage(permission.queuePosition, permission.waitTime);

        logger.info(`[ConversationCoordinator] Conversation ${conversation.id} queued for execution`, {
          position: permission.queuePosition,
          estimatedWait: permission.waitTime,
        });

        // Update queue status
        conversation.metadata.queueStatus = {
          isQueued: true,
          position: permission.queuePosition,
          estimatedWait: permission.waitTime,
          message: queueMessage,
        };

        await this.persistence.save(conversation);
        return false;
      }
    }

    // Handle EXECUTE phase exit
    if (from === PHASES.EXECUTE && phase !== PHASES.EXECUTE && this.executionQueueManager) {
      await this.executionQueueManager.releaseExecution(conversation.id, "phase_transition");
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

    // Log phase transition
    logger.info("[ConversationCoordinator] Phase transition", {
      conversationId: conversation.id,
      from,
      to: phase,
      agent: agentName,
    });

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
   * Get execution queue manager (if available)
   */
  getExecutionQueueManager(): ExecutionQueueManager | undefined {
    return this.executionQueueManager;
  }

  /**
   * Set execution queue manager
   */
  setExecutionQueueManager(manager: ExecutionQueueManager): void {
    this.executionQueueManager = manager;
    this.setupQueueListeners();
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

      logger.info(`[ConversationCoordinator] Loaded ${conversations.length} conversations`);
    } catch (error) {
      logger.error("[ConversationCoordinator] Failed to load conversations", { error });
    }
  }



  private setupQueueListeners(): void {
    const queueManager = this.getExecutionQueueManager();
    if (!queueManager) return;

    queueManager.on("lock-acquired", async (conversationId: string, _agentPubkey: string) => {
      const conversation = this.store.get(conversationId);
      if (conversation?.metadata.queueStatus) {
        conversation.metadata.queueStatus = undefined;
        await this.persistence.save(conversation);

        logInfo(
          "Execution lock acquired - starting EXECUTE phase",
          "conversation",
          "verbose",
          { conversationId }
        );
      }
    });

    // Timeout functionality disabled - no timeout handling needed
  }

  private formatQueueMessage(position: number, waitTimeSeconds: number): string {
    const waitTime = this.formatWaitTime(waitTimeSeconds);
    return `🚦 Execution Queue Status\n\nYour conversation has been added to the execution queue.\n\nQueue Position: ${position}\nEstimated Wait Time: ${waitTime}\n\nYou will be automatically notified when execution begins.`;
  }

  private formatWaitTime(seconds: number): string {
    if (seconds < 60) {
      return `~${Math.floor(seconds)} seconds`;
    }
    if (seconds < 3600) {
      return `~${Math.floor(seconds / 60)} minutes`;
    }
    return `~${Math.floor(seconds / 3600)} hours`;
  }
}
