import type { AgentInstance } from "@/agents/types";
import { createExecutionLogger } from "@/logging/UnifiedLogger";
import {
  buildPhaseInstructions,
  formatPhaseTransitionMessage,
} from "@/prompts/utils/phaseInstructionsBuilder";
import type { TracingContext } from "@/tracing";
import { createPhaseExecutionContext, createTracingContext } from "@/tracing";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Message } from "multi-llm-ts";
import { AgentConversationContext } from "../AgentConversationContext";
import { MessageBuilder } from "../MessageBuilder";
import type { ExecutionQueueManager } from "../executionQueue";
import { ensureExecutionTimeInitialized } from "../executionTime";
import type { Phase } from "../phases";
import { PHASES } from "../phases";
import type { AgentState, Conversation, ConversationMetadata } from "../types";
import type { IAgentResolver } from "./AgentResolver";
import type { ConversationEventProcessor } from "./ConversationEventProcessor";
import type { IConversationPersistenceService } from "./ConversationPersistenceService";
import type { ConversationStore } from "./ConversationStore";
import type { PhaseManager, PhaseTransitionContext } from "./PhaseManager";

/**
 * Coordinates between all conversation services.
 * Single Responsibility: Orchestrate calls to specialized services.
 */
export class ConversationCoordinator {
  private store: ConversationStore;
  private persistence: IConversationPersistenceService;
  private phaseManager: PhaseManager;
  private eventProcessor: ConversationEventProcessor;
  private messageBuilder: MessageBuilder;

  // Context management
  private conversationContexts: Map<string, TracingContext> = new Map();
  private agentContexts: Map<string, AgentConversationContext> = new Map();

  constructor(
    store: ConversationStore,
    persistence: IConversationPersistenceService,
    phaseManager: PhaseManager,
    eventProcessor: ConversationEventProcessor,
    _agentResolver: IAgentResolver,
    executionQueueManager?: ExecutionQueueManager
  ) {
    this.store = store;
    this.persistence = persistence;
    this.phaseManager = phaseManager;
    this.eventProcessor = eventProcessor;
    this.messageBuilder = new MessageBuilder();

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

    // Create tracing context
    const tracingContext = createTracingContext(conversation.id);
    this.conversationContexts.set(conversation.id, tracingContext);

    const executionLogger = createExecutionLogger(tracingContext, "conversation");
    await executionLogger.logEvent(
      "conversation_start",
      {
        userMessage: event.content || "",
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
      const tracingContext = this.getOrCreateTracingContext(id);
      const phaseContext = createPhaseExecutionContext(tracingContext, phase);
      const executionLogger = createExecutionLogger(phaseContext, "conversation");

      await executionLogger.logEvent(
        "phase_transition",
        {
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

    // Get or create the agent context
    const context = this.getOrCreateAgentContext(conversationId, targetAgent.slug);

    // Clear processed event IDs to ensure we rebuild the full conversation history
    // This is critical for the agent to see its own previous responses
    context.clearProcessedEvents();

    // Get or initialize the agent's state
    let agentState = conversation.agentStates.get(targetAgent.slug);
    if (!agentState) {
      agentState = {
        lastProcessedMessageIndex: 0,
        lastSeenPhase: undefined,
      };
      conversation.agentStates.set(targetAgent.slug, agentState);
    }

    // Check if we need to show phase instructions
    const agentHasSeenPhase = agentState.lastSeenPhase !== undefined;

    if (agentHasSeenPhase && agentState.lastSeenPhase) {
      context.setCurrentPhase(agentState.lastSeenPhase);
    }

    const needsPhaseInstructions =
      !agentHasSeenPhase || context.getCurrentPhase() !== conversation.phase;

    // Build complete history
    const historyToProcess: NDKEvent[] = [];
    for (const event of conversation.history) {
      if (triggeringEvent?.id && event.id === triggeringEvent.id) {
        break;
      }
      historyToProcess.push(event);
    }

    if (historyToProcess.length > 0) {
      await context.addEvents(historyToProcess);
    }

    // Handle phase transitions
    if (needsPhaseInstructions) {
      const phaseInstructions = buildPhaseInstructions(conversation.phase, conversation);

      let phaseMessage: string;
      if (agentState.lastSeenPhase) {
        phaseMessage = formatPhaseTransitionMessage(
          agentState.lastSeenPhase,
          conversation.phase,
          phaseInstructions
        );
      } else {
        phaseMessage = `=== CURRENT PHASE: ${conversation.phase.toUpperCase()} ===\n\n${phaseInstructions}`;
      }

      context.handlePhaseTransition(conversation.phase, phaseMessage);
      agentState.lastSeenPhase = conversation.phase;
    }

    // Delegation responses are now handled by DelegationRegistry in reply.ts

    // Add the triggering event
    if (triggeringEvent) {
      await context.addTriggeringEvent(triggeringEvent);
    }

    // Update state
    context.setLastProcessedIndex(conversation.history.length);
    agentState.lastProcessedMessageIndex = conversation.history.length;

    const sessionId = context.getClaudeSessionId();
    if (sessionId && conversation.phase) {
      if (!agentState.claudeSessionsByPhase) {
        agentState.claudeSessionsByPhase = {} as Record<Phase, string>;
      }
      agentState.claudeSessionsByPhase[conversation.phase] = sessionId;
    }

    await this.persistence.save(conversation);

    return {
      messages: context.getMessages(),
      claudeSessionId:
        sessionId || (conversation.phase && agentState.claudeSessionsByPhase?.[conversation.phase]),
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
    this.conversationContexts.delete(conversationId);
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
    this.conversationContexts.delete(conversationId);

    await this.persistence.save(conversation);
  }

  /**
   * Get the tracing context for a conversation
   */
  getTracingContext(conversationId: string): TracingContext | undefined {
    return this.conversationContexts.get(conversationId);
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

  private getOrCreateTracingContext(conversationId: string): TracingContext {
    let context = this.conversationContexts.get(conversationId);
    if (!context) {
      context = createTracingContext(conversationId);
      this.conversationContexts.set(conversationId, context);
    }
    return context;
  }

  private getOrCreateAgentContext(
    conversationId: string,
    agentSlug: string
  ): AgentConversationContext {
    const key = `${conversationId}:${agentSlug}`;
    let context = this.agentContexts.get(key);

    if (!context) {
      context = new AgentConversationContext(conversationId, agentSlug, this.messageBuilder);
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

          const tracingContext = this.conversationContexts.get(conversationId);
          if (tracingContext) {
            const executionLogger = createExecutionLogger(tracingContext, "conversation");
            await executionLogger.logEvent(
              "execution_start",
              {
                narrative: "Execution lock acquired - starting EXECUTE phase",
              }
            );
          }
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
        const tracingContext = this.conversationContexts.get(conversationId);
        if (tracingContext) {
          const minutes = Math.floor(remainingMs / 60000);
          const warningMessage = `⚠️ Execution Timeout Warning\n\nYour conversation has been executing for an extended period.\nTime remaining: ${minutes} minutes\n\nThe execution will be automatically terminated if not completed soon.`;

          // Log timeout warning using execution logger
          const executionLogger = createExecutionLogger(tracingContext, "conversation");
          await executionLogger.logEvent(
            "execution_start",
            {
              narrative: warningMessage,
            }
          );
        }
      }
    );
  }
}
