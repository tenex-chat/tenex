import type { Agent } from "@/agents/types";
import type { Phase } from "@/conversations/phases";
import type { PhaseTransition } from "@/conversations/types";
import type { ToolExecutionResult } from "@/tools/types";

export interface ExecutionContext {
    agent: Agent;
    conversationId: string;
    phase: Phase;
    projectPath: string;
    triggeringEvent: import("@nostr-dev-kit/ndk").NDKEvent;
    publisher: import("@/nostr/NostrPublisher").NostrPublisher;
    conversationManager: import("@/conversations/ConversationManager").ConversationManager;
    previousPhase?: Phase;
    handoff?: PhaseTransition;
    claudeSessionId?: string;
    agentExecutor?: import("@/agents/execution/AgentExecutor").AgentExecutor;
}

export interface AgentExecutionResult {
    success: boolean;
    response?: string;
    toolExecutions?: ToolExecutionResult[];
    error?: string;
}
