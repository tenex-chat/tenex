import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Message } from "multi-llm-ts";
import type { Phase } from "./phases";

export interface AgentContext {
    agentSlug: string;
    messages: Message[]; // Agent's isolated view
    tokenCount: number;
    lastUpdate: Date;
    claudeSessionId?: string; // Claude Code session ID for this agent
}

export interface Conversation {
    id: string;
    title: string;
    phase: Phase;
    history: NDKEvent[]; // Master audit trail
    agentContexts: Map<string, AgentContext>; // Per-agent contexts
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
    continueCallCounts?: Record<Phase, number>; // Track continue calls per phase
    projectPath?: string; // Project path for debug commands
    last_user_message?: string; // Last message from the user
    referencedArticle?: {
        title: string;
        content: string;
        dTag: string;
    }; // NDKArticle referenced by kind:11 event (30023)
}

export interface PhaseTransition {
    from: Phase;
    to: Phase;
    message: string; // Comprehensive context from the transition
    timestamp: number;
    agentPubkey: string; // Track which agent initiated
    agentName: string; // Human-readable agent name
    reason?: string; // Brief description (optional)

    // Enhanced handoff fields
    summary?: string; // State summary for receiving agent
}
