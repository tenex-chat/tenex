import type { Agent } from "@/agents/types";
import type { Phase } from "@/conversations/phases";
import type { PhaseTransition } from "@/conversations/types";
import type { ToolExecutionResult } from "@/tools/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { NostrPublisher } from "@/nostr/NostrPublisher";
import type { ConversationManager } from "@/conversations/ConversationManager";
import type { AgentExecutor } from "@/agents/execution/AgentExecutor";

export interface ExecutionContext {
    agent: Agent;
    conversationId: string;
    phase: Phase;
    projectPath: string;
    triggeringEvent: NDKEvent;
    publisher: NostrPublisher;
    conversationManager: ConversationManager;
    previousPhase?: Phase;
    handoff?: PhaseTransition;
    claudeSessionId?: string;
    agentExecutor?: AgentExecutor;
}

export interface AgentExecutionResult {
    success: boolean;
    response?: string;
    toolExecutions?: ToolExecutionResult[];
    error?: string;
}
