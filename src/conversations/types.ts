import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Phase } from "./phases";

// Simplified agent state to track what an agent has seen
export interface AgentState {
    lastProcessedMessageIndex: number; // Index into Conversation.history
    claudeSessionId?: string; // Claude Code session ID (if per-agent per-conversation)
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
    orchestratorTurns: OrchestratorTurn[]; // Track all orchestrator routing decisions

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
    reason?: string; // Brief description (optional)

    // Enhanced handoff fields
    summary?: string; // State summary for receiving agent
}

// Orchestrator routing context types
export interface OrchestratorRoutingContext {
    user_request: string;  // Original user request that started the conversation
    routing_history: RoutingEntry[];  // All past completed routing decisions
    current_routing: RoutingEntry | null;  // Active routing (if agents working) or null (if need new routing)
}

export interface RoutingEntry {
    phase: Phase;
    agents: string[];  // Agents routed to
    completions: Completion[];  // Their complete() outputs
    reason?: string;  // Why this routing was chosen
    timestamp?: number;  // When routing decision was made
}

export interface Completion {
    agent: string;  // Agent slug
    message: string;  // The complete() tool response
    timestamp?: number;  // When completion happened
}

// Orchestrator turn tracking (internal state)
export interface OrchestratorTurn {
    turnId: string;  // Unique ID for this orchestrator turn
    timestamp: number;  // When orchestrator made this decision
    phase: Phase;
    agents: string[];  // Agents routed to
    completions: Completion[];  // Outcomes from those agents
    reason?: string;  // Orchestrator's reasoning
    isCompleted: boolean;  // All expected agents completed?
}
