import { logger } from "@/utils/logger";
import { FileSystemAdapter } from "../persistence";
import type {
    ConversationMetadata,
    ConversationPersistenceAdapter,
    ConversationSearchCriteria,
} from "../persistence/types";
import type { Conversation } from "../types";

/**
 * Service for persisting conversations to storage.
 * Single Responsibility: Handle all persistence operations.
 */
export interface IConversationPersistenceService {
    initialize(): Promise<void>;
    save(conversation: Conversation): Promise<void>;
    load(id: string): Promise<Conversation | null>;
    loadAll(): Promise<Conversation[]>;
    archive(id: string): Promise<void>;
    search(criteria: ConversationSearchCriteria): Promise<Conversation[]>;
}

export class ConversationPersistenceService implements IConversationPersistenceService {
    constructor(private adapter: ConversationPersistenceAdapter) {}

    async initialize(): Promise<void> {
        await this.adapter.initialize();
    }

    async save(conversation: Conversation): Promise<void> {
        await this.adapter.save(conversation);
        logger.debug(`[ConversationPersistenceService] Saved conversation ${conversation.id}`);
    }

    async load(id: string): Promise<Conversation | null> {
        const conversation = await this.adapter.load(id);
        if (conversation) {
            logger.debug(`[ConversationPersistenceService] Loaded conversation ${id}`);
        }
        return conversation;
    }

    async loadAll(): Promise<Conversation[]> {
        const metadata = await this.adapter.list();
        const conversations: Conversation[] = [];

        for (const meta of metadata) {
            if (!meta.archived) {
                const conversation = await this.adapter.load(meta.id);
                if (conversation) {
                    conversations.push(conversation);
                }
            }
        }

        return conversations;
    }

    async archive(id: string): Promise<void> {
        await this.adapter.archive(id);
        logger.info(`[ConversationPersistenceService] Archived conversation ${id}`);
    }

    async search(criteria: ConversationSearchCriteria): Promise<Conversation[]> {
        const metadata = await this.adapter.search(criteria);
        const conversations: Conversation[] = [];

        for (const meta of metadata) {
            const conversation = await this.adapter.load(meta.id);
            if (conversation) {
                conversations.push(conversation);
            }
        }

        return conversations;
    }
}

/**
 * Factory function to create a file-based persistence service
 */
export function createFileSystemPersistenceService(
    projectPath: string
): ConversationPersistenceService {
    return new ConversationPersistenceService(new FileSystemAdapter(projectPath));
}

/**
 * In-memory persistence adapter for testing and standalone usage
 */
export class InMemoryPersistenceAdapter implements ConversationPersistenceAdapter {
    private conversations: Map<string, Conversation> = new Map();
    private metadata: Map<string, ConversationMetadata> = new Map();

    async initialize(): Promise<void> {
        // No initialization needed for in-memory storage
    }

    async save(conversation: Conversation): Promise<void> {
        this.conversations.set(conversation.id, conversation);
        this.metadata.set(conversation.id, {
            id: conversation.id,
            title: conversation.title || "",
            createdAt: conversation.history[0]?.created_at || Date.now(),
            updatedAt: Date.now(),
            eventCount: conversation.history.length,
            agentCount: conversation.agentStates.size,
            archived: false,
            phase: conversation.phase,
        });
    }

    async load(conversationId: string): Promise<Conversation | null> {
        return this.conversations.get(conversationId) || null;
    }

    async delete(conversationId: string): Promise<void> {
        this.conversations.delete(conversationId);
        this.metadata.delete(conversationId);
    }

    async list(): Promise<ConversationMetadata[]> {
        return Array.from(this.metadata.values());
    }

    async search(criteria: ConversationSearchCriteria): Promise<ConversationMetadata[]> {
        let results = Array.from(this.metadata.values());

        if (criteria.title) {
            const searchTitle = criteria.title.toLowerCase();
            results = results.filter((m) => m.title.toLowerCase().includes(searchTitle));
        }

        if (criteria.phase) {
            results = results.filter((m) => m.phase === criteria.phase);
        }

        if (criteria.archived !== undefined) {
            results = results.filter((m) => m.archived === criteria.archived);
        }

        return results;
    }

    async archive(conversationId: string): Promise<void> {
        const meta = this.metadata.get(conversationId);
        if (meta) {
            meta.archived = true;
        }
    }

    async restore(conversationId: string): Promise<void> {
        const meta = this.metadata.get(conversationId);
        if (meta) {
            meta.archived = false;
        }
    }
}
