import { NDKKind } from "@/nostr/kinds";
import type { ProjectContext } from "@/services/projects";
import type { TodoItem } from "@/services/ral/types";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { ensureExecutionTimeInitialized } from "../executionTime";
import type { ConversationPersistenceAdapter } from "../persistence/types";
import type { AgentState, Conversation, ConversationMetadata } from "../types";
import { ConversationEventProcessor } from "./ConversationEventProcessor";
import {
    ConversationPersistenceService,
    InMemoryPersistenceAdapter,
    type IConversationPersistenceService,
} from "./ConversationPersistenceService";
import { ConversationStore } from "./ConversationStore";
import { ConversationSummarizer } from "./ConversationSummarizer";
import { ParticipationIndex } from "./ParticipationIndex";
import { SummarizationTimerManager } from "./SummarizationTimerManager";
import { ThreadService } from "./ThreadService";

/**
 * Coordinates between all conversation services.
 * Single Responsibility: Orchestrate calls to specialized services.
 */
export class ConversationCoordinator {
    private store: ConversationStore;
    private persistence: IConversationPersistenceService;
    private eventProcessor: ConversationEventProcessor;
    private timerManager?: SummarizationTimerManager;

    // NEW: Expose decomposed services for strategies to use
    public readonly threadService = new ThreadService();
    public readonly participationIndex = new ParticipationIndex();

    constructor(
        projectPath: string,
        persistence?: ConversationPersistenceAdapter,
        context?: ProjectContext
    ) {
        if (!projectPath || projectPath === "undefined") {
            throw new Error(
                `ConversationCoordinator requires a valid projectPath. Received: ${String(projectPath)}`
            );
        }

        // Create services
        this.store = new ConversationStore();
        this.persistence = new ConversationPersistenceService(
            persistence || new InMemoryPersistenceAdapter()
        );
        this.eventProcessor = new ConversationEventProcessor();

        // Create summarization services if context is provided
        if (context) {
            const summarizer = new ConversationSummarizer(context);
            this.timerManager = new SummarizationTimerManager(summarizer);
        }
    }

    /**
     * Initialize the coordinator
     */
    async initialize(): Promise<void> {
        await this.persistence.initialize();
        await this.loadConversations();

        // Initialize timer manager if present
        if (this.timerManager) {
            await this.timerManager.initialize();
        }

        // Build participation indices for loaded conversations
        for (const conversation of this.store.getAll()) {
            this.participationIndex.buildIndex(conversation.id, conversation.history);
        }
    }

    /**
     * Create a new conversation from an event.
     * Returns existing conversation if one with the same ID already exists.
     */
    async createConversation(event: NDKEvent): Promise<Conversation> {
        const eventId = event.id;
        if (!eventId) {
            throw new Error("Event must have an ID to create a conversation");
        }

        // Check if conversation already exists (event may arrive from multiple relays)
        const existing = this.store.get(eventId);
        if (existing) {
            logger.debug(
                `Conversation ${eventId.substring(0, 8)} already exists, returning existing`
            );
            return existing;
        }

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

        // Schedule summarization if not a metadata event
        if (this.timerManager && event.kind !== NDKKind.EventMetadata) {
            this.timerManager.scheduleSummarization(conversation);
        }

        // NEW: Update participation index whenever events are added
        this.participationIndex.buildIndex(conversationId, conversation.history);

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
        // Clear all summarization timers
        if (this.timerManager) {
            this.timerManager.clearAllTimers();
        }

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

        this.store.delete(conversationId);

        await this.persistence.save(conversation);
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

                // Ensure agentTodos is a Map
                if (!(conversation.agentTodos instanceof Map)) {
                    const todosObj = conversation.agentTodos as Record<string, TodoItem[]>;
                    conversation.agentTodos = new Map(Object.entries(todosObj || {}));
                }

                this.store.set(conversation.id, conversation);
            }
        } catch (error) {
            logger.error("[ConversationCoordinator] Failed to load conversations", { error });
        }
    }
}
