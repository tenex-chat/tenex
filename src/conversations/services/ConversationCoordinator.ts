import type { AgentInstance } from "@/agents/types";
import {
  buildPhaseInstructions,
  formatPhaseTransitionMessage,
} from "@/prompts/utils/phaseInstructionsBuilder";
import { logger, logInfo, logWarning } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Message } from "multi-llm-ts";
import { AgentConversationContext } from "../AgentConversationContext";
import type { ExecutionQueueManager } from "../executionQueue";
import { ensureExecutionTimeInitialized } from "../executionTime";
import { FileSystemAdapter } from "../persistence";
import type { ConversationPersistenceAdapter } from "../persistence/types";
import type { Phase } from "../phases";
import { PHASES } from "../phases";
import type { AgentState, Conversation, ConversationMetadata } from "../types";
import { ConversationEventProcessor } from "./ConversationEventProcessor";
import { ConversationPersistenceService, type IConversationPersistenceService } from "./ConversationPersistenceService";
import { ConversationStore } from "./ConversationStore";
import { PhaseManager, type PhaseTransitionContext } from "./PhaseManager";

/**
 * Coordinates between all conversation services.
 * Single Responsibility: Orchestrate calls to specialized services.
 */
export class ConversationCoordinator {
  private store: ConversationStore;
  private persistence: IConversationPersistenceService;
  private phaseManager: PhaseManager;
  private eventProcessor: ConversationEventProcessor;

  // Agent message contexts (for building conversation history per agent)
  private agentContexts: Map<string, AgentConversationContext> = new Map();

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
    this.phaseManager = new PhaseManager(executionQueueManager);
    this.eventProcessor = new ConversationEventProcessor();

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

    const context: PhaseTransitionContext = {
      agentPubkey,
      agentName,
      message,
    };

    const result = await this.phaseManager.transition(conversation, phase, context);

    if (result.success && result.transition) {
      const previousPhase = conversation.phase;

      // Update conversation
      if (previousPhase !== phase) {
        conversation.phase = phase;
        conversation.phaseStartedAt = Date.now();

        // Clear readFiles when transitioning from REFLECTION back to CHAT
        if (previousPhase === PHASES.REFLECTION && phase === PHASES.CHAT) {
          conversation.metadata.readFiles = undefined;
        }
      }

      conversation.phaseTransitions.push(result.transition);

      // Log phase transition
      logInfo(
        `Phase transition: ${previousPhase} → ${phase}`,
        "conversation",
        "verbose",
        {
          conversationId: id,
          from: previousPhase,
          to: phase,
        }
      );

      await this.persistence.save(conversation);
      return true;
    }
    if (result.queued) {
      // Handle queue status
      if (!result.queuePosition || !result.estimatedWait || !result.queueMessage) {
        throw new Error("Invalid queue result - missing required properties");
      }
      conversation.metadata.queueStatus = {
        isQueued: true,
        position: result.queuePosition,
        estimatedWait: result.estimatedWait,
        message: result.queueMessage,
      };

      await this.persistence.save(conversation);
      return false;
    }

    return false;
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

    // Get or create the agent context (now stateless)
    const context = this.getOrCreateAgentContext(conversationId, targetAgent.slug);

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
      const instructions = buildPhaseInstructions(conversation.phase, conversation);
      if (agentState.lastSeenPhase) {
        phaseInstructions = formatPhaseTransitionMessage(
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
    
    // Clean up agent contexts for this conversation
    const keysToDelete = [];
    for (const [key] of this.agentContexts) {
      if (key.startsWith(`${conversationId}:`)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.agentContexts.delete(key);
    }
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
    
    // Clean up agent contexts for this conversation
    const keysToDelete = [];
    for (const [key] of this.agentContexts) {
      if (key.startsWith(`${conversationId}:`)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.agentContexts.delete(key);
    }

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
    return this.phaseManager.getExecutionQueueManager();
  }

  /**
   * Set execution queue manager
   */
  setExecutionQueueManager(manager: ExecutionQueueManager): void {
    this.phaseManager.setExecutionQueueManager(manager);
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


  private getOrCreateAgentContext(
    conversationId: string,
    agentSlug: string
  ): AgentConversationContext {
    const key = `${conversationId}:${agentSlug}`;
    let context = this.agentContexts.get(key);

    if (!context) {
      context = new AgentConversationContext(conversationId, agentSlug);
      this.agentContexts.set(key, context);
    }

    return context;
  }

  private setupQueueListeners(): void {
    const queueManager = this.getExecutionQueueManager();
    if (!queueManager) return;

    this.phaseManager.setupQueueListeners(
      async (conversationId: string, _agentPubkey: string) => {
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
      },
      async (conversationId: string) => {
        const conversation = this.store.get(conversationId);
        if (conversation && conversation.phase === PHASES.EXECUTE) {
          await this.updatePhase(
            conversationId,
            PHASES.CHAT,
            "Execution timeout reached. The execution lock has been automatically released.",
            "system",
            "system"
          );
        }
      },
      async (conversationId: string, remainingMs: number) => {
        const minutes = Math.floor(remainingMs / 60000);
        logWarning(
          `Execution timeout warning: ${minutes} minutes remaining`,
          "conversation",
          "normal",
          { conversationId, remainingMinutes: minutes }
        );
      }
    );
  }
}
