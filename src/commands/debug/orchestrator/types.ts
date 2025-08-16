import type { Phase } from "@/conversations/phases";
import type { 
    RoutingEntry, 
    OrchestratorTurn, 
    AgentState, 
    ConversationMetadata
} from "@/conversations/types";

export interface OrchestratorDebugState {
    userRequest: string;
    originalRequest?: string;
    phase: Phase;
    routingHistory: RoutingEntry[];  // Keep for internal tracking
    workflowNarrative?: string;  // The new narrative that the orchestrator sees
    currentRouting: RoutingEntry | null;
    orchestratorTurns: OrchestratorTurn[];
    agentStates: Map<string, AgentState>;
    metadata: ConversationMetadata;
    
    // Debug-specific fields
    conversationId?: string;
    loadedFrom?: string; // Track if loaded from existing conversation
}

export type DebugAction = 
    | 'user-message'
    | 'add-completion' 
    | 'change-phase'
    | 'edit-history'
    | 'inject-turn'
    | 'clear-state'
    | 'load-conversation'
    | 'run-orchestrator'
    | 'debug-reasoning'
    | 'list-agents'
    | 'export-state'
    | 'show-context'
    | 'exit';

export interface SimulatedCompletion {
    agentSlug: string;
    response: string;
    summary?: string;
    timestamp?: number;
}

export interface ExportFormat {
    type: 'typescript' | 'json' | 'markdown';
    filename?: string;
}