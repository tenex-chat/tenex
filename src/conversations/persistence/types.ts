import type { Conversation } from "../types";

export interface ConversationMetadata {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    phase: string;
    eventCount: number;
    agentCount: number;
    archived?: boolean;
}

export interface ConversationSearchCriteria {
    title?: string;
    phase?: string;
    dateFrom?: number;
    dateTo?: number;
    agentPubkey?: string;
    archived?: boolean;
}

export interface ConversationPersistenceAdapter {
    save(conversation: Conversation): Promise<void>;
    load(conversationId: string): Promise<Conversation | null>;
    delete(conversationId: string): Promise<void>;
    list(): Promise<ConversationMetadata[]>;
    search(criteria: ConversationSearchCriteria): Promise<ConversationMetadata[]>;
    archive(conversationId: string): Promise<void>;
    restore(conversationId: string): Promise<void>;
}
