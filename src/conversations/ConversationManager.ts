import * as path from "node:path";
import type { Phase } from "@/conversations/phases";
import type { AgentState, PhaseTransition, Conversation, ConversationMetadata, OrchestratorRoutingContext } from "@/conversations/types";
import { ensureDirectory } from "@/lib/fs";
import type { TracingContext } from "@/tracing";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
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
    OrchestratorTurnTracker,
    ProjectAgentResolver,
    ConversationCoordinator,
    type IConversationPersistenceService
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
        this.conversationsDir = path.join(projectPath, ".tenex", "conversations");
        
        // Create services
        const store = new ConversationStore();
        const persistenceService = new ConversationPersistenceService(
            persistence || new FileSystemAdapter(projectPath)
        );
        const phaseManager = new PhaseManager(executionQueueManager);
        const eventProcessor = new ConversationEventProcessor();
        const turnTracker = new OrchestratorTurnTracker();
        const agentResolver = new ProjectAgentResolver();
        
        // Create coordinator
        this.coordinator = new ConversationCoordinator(
            store,
            persistenceService,
            phaseManager,
            eventProcessor,
            turnTracker,
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

    async buildOrchestratorRoutingContext(
        conversationId: string,
        triggeringEvent?: NDKEvent
    ): Promise<OrchestratorRoutingContext> {
        return await this.coordinator.buildOrchestratorRoutingContext(
            conversationId,
            triggeringEvent
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

    async startOrchestratorTurn(
        conversationId: string,
        phase: Phase,
        agents: string[],
        reason?: string
    ): Promise<string> {
        return await this.coordinator.startOrchestratorTurn(
            conversationId,
            phase,
            agents,
            reason
        );
    }

    async addCompletionToTurn(
        conversationId: string,
        agentSlug: string,
        message: string
    ): Promise<void> {
        return await this.coordinator.addCompletionToTurn(
            conversationId,
            agentSlug,
            message
        );
    }

    // Stub method kept for compatibility
    private setupQueueEventListeners(): void {
        // Now handled internally by the coordinator
    }
}