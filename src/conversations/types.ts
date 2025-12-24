import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { TodoItem } from "@/services/ral/types";

// Simplified agent state to track what an agent has seen
export interface AgentState {
    lastProcessedMessageIndex: number; // Index into Conversation.history
}

export interface Conversation {
    id: string;
    title?: string;
    phase?: string;
    phaseStartedAt?: number;
    history: NDKEvent[]; // The SINGLE source of truth for all events/messages
    agentStates: Map<string, AgentState>; // Track what each agent has seen in 'history'
    agentTodos: Map<string, TodoItem[]>; // Track todos per agent (keyed by agent pubkey)
    metadata: ConversationMetadata;
    blockedAgents: Set<string>; // Agent pubkeys that are blocked from executing in this conversation

    // Execution time tracking
    executionTime: {
        totalSeconds: number;
        currentSessionStart?: number;
        isActive: boolean;
        lastUpdated: number;
    };
}

export interface ConversationMetadata {
    phase?: string;
    branch?: string; // Git branch for execution phase
    summary?: string; // Current understanding/summary
    requirements?: string; // Captured requirements
    plan?: string; // Approved plan
    projectPath?: string; // Project path for debug commands
    last_user_message?: string; // Last message from the user
    referencedArticle?: {
        title: string;
        content: string;
        dTag: string;
    }; // NDKArticle referenced by kind:11 event (30023)
}
