import type { NDKEvent } from "@nostr-dev-kit/ndk";

// Simplified agent state to track what an agent has seen
export interface AgentState {
  lastProcessedMessageIndex: number; // Index into Conversation.history
}

export interface Conversation {
  id: string;
  title?: string;
  history: NDKEvent[]; // The SINGLE source of truth for all events/messages
  agentStates: Map<string, AgentState>; // Track what each agent has seen in 'history'
  metadata: ConversationMetadata;

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
  readFiles?: string[]; // Files read during this conversation
  projectPath?: string; // Project path for debug commands
  last_user_message?: string; // Last message from the user
  referencedArticle?: {
    title: string;
    content: string;
    dTag: string;
  }; // NDKArticle referenced by kind:11 event (30023)
}

