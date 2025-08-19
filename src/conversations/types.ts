import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Phase } from "./phases";

// Simplified agent state to track what an agent has seen
export interface AgentState {
    lastProcessedMessageIndex: number; // Index into Conversation.history
    claudeSessionsByPhase?: Record<Phase, string>; // Claude Code session IDs per phase
    lastSeenPhase?: Phase; // Track the last phase this agent operated in
}

export interface Conversation {
    id: string;
    title: string;
    phase: Phase;
    history: NDKEvent[]; // The SINGLE source of truth for all events/messages
    agentStates: Map<string, AgentState>; // Track what each agent has seen in 'history'
    phaseStartedAt?: number;
    metadata: ConversationMetadata;
    phaseTransitions: PhaseTransition[]; // First-class phase transition history

    // Execution time tracking
    executionTime: {
        totalSeconds: number;
        currentSessionStart?: number;
        isActive: boolean;
        lastUpdated: number;
    };
}

export interface ConversationMetadata {
    branch?: string; // Git branch for execution phase
    summary?: string; // Current understanding/summary
    requirements?: string; // Captured requirements
    plan?: string; // Approved plan
    readFiles?: string[]; // Files read during this conversation (for write_context_file security)
    projectPath?: string; // Project path for debug commands
    last_user_message?: string; // Last message from the user
    referencedArticle?: {
        title: string;
        content: string;
        dTag: string;
    }; // NDKArticle referenced by kind:11 event (30023)
    queueStatus?: {
        isQueued: boolean;
        position: number;
        estimatedWait: number;
        message: string;
    }; // Execution queue status when waiting for EXECUTE phase
}

export interface PhaseTransition {
    from: Phase;
    to: Phase;
    message: string; // Comprehensive context from the transition
    timestamp: number;
    agentPubkey: string; // Track which agent initiated
    agentName: string; // Human-readable agent name
}

