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
 * ConversationManager - Alias for ConversationCoordinator to maintain backward compatibility.
 * This class creates and returns a ConversationCoordinator instance.
 */
export class ConversationManager extends ConversationCoordinator {
    private projectPath: string;
    private conversationsDir: string;

    constructor(
        projectPath: string, 
        persistence?: ConversationPersistenceAdapter,
        executionQueueManager?: ExecutionQueueManager
    ) {
        const conversationsDir = path.join(projectPath, TENEX_DIR, CONVERSATIONS_DIR);
        
        // Create services
        const store = new ConversationStore();
        const persistenceService = new ConversationPersistenceService(
            persistence || new FileSystemAdapter(projectPath)
        );
        const phaseManager = new PhaseManager(executionQueueManager);
        const eventProcessor = new ConversationEventProcessor();
        const agentResolver = new ProjectAgentResolver();
        
        // Call parent constructor
        super(
            store,
            persistenceService,
            phaseManager,
            eventProcessor,
            agentResolver,
            executionQueueManager
        );
        
        this.projectPath = projectPath;
        this.conversationsDir = conversationsDir;
    }

    getProjectPath(): string {
        return this.projectPath;
    }

    async initialize(): Promise<void> {
        await ensureDirectory(this.conversationsDir);
        await super.initialize();
    }


    async loadConversation(id: string): Promise<Conversation | undefined> {
        // First check if already in memory
        const existing = this.getConversation(id);
        if (existing) {
            return existing;
        }

        // Try to load from disk
        const persistence = (this as any).persistence;
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
                (this as any).store.set(id, loaded);
                return loaded;
            }
        }
        
        return undefined;
    }


    async saveConversation(conversationId: string): Promise<void> {
        // The coordinator auto-saves, but keep this for compatibility
        const conversation = this.getConversation(conversationId);
        if (conversation) {
            // Trigger a save through metadata update
            await this.updateMetadata(conversationId, {});
        }
    }



}