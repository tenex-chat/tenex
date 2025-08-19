import * as path from "node:path";
import type { Phase } from "@/conversations/phases";
import type { AgentState, PhaseTransition, Conversation, ConversationMetadata } from "@/conversations/types";
import { ensureDirectory } from "@/lib/fs";
import type { TracingContext } from "@/tracing";
import { TENEX_DIR, CONVERSATIONS_DIR } from "@/constants";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";
import { FileSystemAdapter } from "./persistence";
import type { ConversationPersistenceAdapter } from "./persistence/types";
import type { AgentInstance } from "@/agents/types";
import { Message } from "multi-llm-ts";
import { ExecutionQueueManager } from "./executionQueue";
import {
    ConversationStore,
    ConversationPersistenceService,
    PhaseManager,
    ConversationEventProcessor,
    ProjectAgentResolver,
    ConversationCoordinator,
} from "./services";

/**
 * ConversationManager - Now a facade that delegates to specialized services.
 * Maintained for backward compatibility.
 */
export class ConversationManager {
    private coordinator: ConversationCoordinator;
    private conversationsDir: string;

    constructor(
        private projectPath: string, 
        persistence?: ConversationPersistenceAdapter,
        executionQueueManager?: ExecutionQueueManager
    ) {
        this.conversationsDir = path.join(projectPath, TENEX_DIR, CONVERSATIONS_DIR);
        
        // Create services
        const store = new ConversationStore();
        const persistenceService = new ConversationPersistenceService(
            persistence || new FileSystemAdapter(projectPath)
        );
        const phaseManager = new PhaseManager(executionQueueManager);
        const eventProcessor = new ConversationEventProcessor();
        const agentResolver = new ProjectAgentResolver();
        
        // Create coordinator
        this.coordinator = new ConversationCoordinator(
            store,
            persistenceService,
            phaseManager,
            eventProcessor,
            agentResolver,
            executionQueueManager
        );
    }

    getProjectPath(): string {
        return this.projectPath;
    }

    getExecutionQueueManager(): ExecutionQueueManager | undefined {
        return this.coordinator.getExecutionQueueManager();
    }

    setExecutionQueueManager(manager: ExecutionQueueManager): void {
        this.coordinator.setExecutionQueueManager(manager);
    }

    async initialize(): Promise<void> {
        await ensureDirectory(this.conversationsDir);
        await this.coordinator.initialize();
    }

    async createConversation(event: NDKEvent): Promise<Conversation> {
        return await this.coordinator.createConversation(event);
    }

    getConversation(id: string): Conversation | undefined {
        return this.coordinator.getConversation(id);
    }

    async loadConversation(id: string): Promise<Conversation | undefined> {
        // First check if already in memory
        const existing = this.coordinator.getConversation(id);
        if (existing) {
            return existing;
        }

        // Try to load from disk
        const persistence = (this.coordinator as any).persistence;
        if (persistence && persistence.adapter) {
            const loaded = await persistence.adapter.load(id);
            if (loaded) {
                // Ensure execution time is initialized
                if (!loaded.executionTime) {
                    loaded.executionTime = {
                        totalSeconds: 0,
                        isActive: false,
                        lastUpdated: Date.now()
                    };
                }
                // Ensure agentStates is a Map
                if (!(loaded.agentStates instanceof Map)) {
                    const statesObj = loaded.agentStates as any;
                    loaded.agentStates = new Map(Object.entries(statesObj || {}));
                }
                // Add to store
                (this.coordinator as any).store.set(id, loaded);
                return loaded;
            }
        }
        
        return undefined;
    }

    async updatePhase(
        id: string,
        phase: Phase,
        message: string,
        agentPubkey: string,
        agentName: string,
        reason?: string,
        summary?: string
    ): Promise<boolean> {
        return await this.coordinator.updatePhase(
            id,
            phase,
            message,
            agentPubkey,
            agentName,
            reason,
            summary
        );
    }

    async addEvent(conversationId: string, event: NDKEvent): Promise<void> {
        return await this.coordinator.addEvent(conversationId, event);
    }

    async updateMetadata(
        conversationId: string,
        metadata: Partial<ConversationMetadata>
    ): Promise<void> {
        return await this.coordinator.updateMetadata(conversationId, metadata);
    }

    getPhaseHistory(conversationId: string): NDKEvent[] {
        return this.coordinator.getPhaseHistory(conversationId);
    }

    getAllConversations(): Conversation[] {
        return this.coordinator.getAllConversations();
    }

    getConversationByEvent(eventId: string): Conversation | undefined {
        return this.coordinator.getConversationByEvent(eventId);
    }

    async buildAgentMessages(
        conversationId: string,
        targetAgent: AgentInstance,
        triggeringEvent?: NDKEvent,
        handoff?: PhaseTransition
    ): Promise<{ messages: Message[]; claudeSessionId?: string }> {
        return await this.coordinator.buildAgentMessages(
            conversationId,
            targetAgent,
            triggeringEvent,
            handoff
        );
    }


    async updateAgentState(
        conversationId: string, 
        agentSlug: string, 
        updates: Partial<AgentState>
    ): Promise<void> {
        return await this.coordinator.updateAgentState(
            conversationId,
            agentSlug,
            updates
        );
    }

    async saveConversation(conversationId: string): Promise<void> {
        // The coordinator auto-saves, but keep this for compatibility
        const conversation = this.coordinator.getConversation(conversationId);
        if (conversation) {
            // Trigger a save through metadata update
            await this.coordinator.updateMetadata(conversationId, {});
        }
    }

    async archiveConversation(conversationId: string): Promise<void> {
        return await this.coordinator.archiveConversation(conversationId);
    }

    async searchConversations(query: string): Promise<Conversation[]> {
        return await this.coordinator.searchConversations(query);
    }

    async cleanup(): Promise<void> {
        return await this.coordinator.cleanup();
    }

    getTracingContext(conversationId: string): TracingContext | undefined {
        return this.coordinator.getTracingContext(conversationId);
    }

    cleanupConversationMetadata(conversationId: string): void {
        this.coordinator.cleanupConversationMetadata(conversationId);
    }

    async completeConversation(conversationId: string): Promise<void> {
        return await this.coordinator.completeConversation(conversationId);
    }


    async addCompletionToTurn(
        _conversationId: string,
        _agentPubkey: string,
        _message: string
    ): Promise<void> {
        // No-op: Turn tracking removed in PM-centric routing
        return;
    }

    isCurrentTurnComplete(_conversationId: string): boolean {
        // Always true: NDKTask-based delegation handles completion tracking
        return true;
    }

    getCurrentTurn(_conversationId: string): null {
        // No turn tracking in PM-centric routing
        return null;
    }


}