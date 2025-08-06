import type { Conversation } from "@/conversations/types";
import type { 
    ConversationPersistenceAdapter, 
    ConversationMetadata,
    ConversationSearchCriteria 
} from "@/conversations/persistence/types";

/**
 * In-memory persistence adapter for testing
 * Avoids file system operations and serialization issues in tests
 */
export class TestPersistenceAdapter implements ConversationPersistenceAdapter {
    private storage = new Map<string, Conversation>();
    private metadata = new Map<string, ConversationMetadata>();
    private archived = new Set<string>();
    
    async initialize(): Promise<void> {
        // No initialization needed for in-memory storage
    }
    
    async save(conversation: Conversation): Promise<void> {
        // Store conversation directly without serialization
        this.storage.set(conversation.id, {
            ...conversation,
            // Deep clone to prevent mutations
            history: [...conversation.history],
            agentStates: new Map(conversation.agentStates),
            phaseTransitions: [...conversation.phaseTransitions]
        });
    }
    
    async load(id: string): Promise<Conversation | null> {
        const stored = this.storage.get(id);
        if (!stored) return null;
        
        // Return a deep clone to prevent mutations
        return {
            ...stored,
            history: [...stored.history],
            agentStates: new Map(stored.agentStates),
            phaseTransitions: [...stored.phaseTransitions]
        };
    }
    
    async delete(id: string): Promise<void> {
        this.storage.delete(id);
        this.metadata.delete(id);
        this.archived.delete(id);
    }
    
    async list(): Promise<ConversationMetadata[]> {
        const metadataList: ConversationMetadata[] = [];
        for (const [id, conv] of this.storage.entries()) {
            if (!this.archived.has(id)) {
                metadataList.push(this.createMetadata(conv));
            }
        }
        return metadataList;
    }
    
    async search(criteria: ConversationSearchCriteria): Promise<ConversationMetadata[]> {
        const results: ConversationMetadata[] = [];
        
        for (const [id, conv] of this.storage.entries()) {
            const meta = this.createMetadata(conv);
            
            // Check archived status
            if (criteria.archived !== undefined) {
                const isArchived = this.archived.has(id);
                if (criteria.archived !== isArchived) continue;
            }
            
            // Check other criteria
            if (criteria.title && !conv.title.toLowerCase().includes(criteria.title.toLowerCase())) {
                continue;
            }
            if (criteria.phase && conv.phase !== criteria.phase) {
                continue;
            }
            if (criteria.dateFrom && meta.createdAt < criteria.dateFrom) {
                continue;
            }
            if (criteria.dateTo && meta.createdAt > criteria.dateTo) {
                continue;
            }
            
            results.push(meta);
        }
        
        return results;
    }
    
    async archive(conversationId: string): Promise<void> {
        if (this.storage.has(conversationId)) {
            this.archived.add(conversationId);
        }
    }
    
    async restore(conversationId: string): Promise<void> {
        this.archived.delete(conversationId);
    }
    
    private createMetadata(conv: Conversation): ConversationMetadata {
        return {
            id: conv.id,
            title: conv.title,
            createdAt: conv.executionTime?.lastUpdated || Date.now(),
            updatedAt: conv.executionTime?.lastUpdated || Date.now(),
            phase: conv.phase,
            eventCount: conv.history.length,
            agentCount: conv.agentStates.size,
            archived: this.archived.has(conv.id)
        };
    }
    
    // Test-specific methods
    clear(): void {
        this.storage.clear();
        this.metadata.clear();
    }
    
    getAll(): Map<string, Conversation> {
        return new Map(this.storage);
    }
}