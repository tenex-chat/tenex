import type { AgentInstance } from "@/agents/types";
import type { Phase } from "@/conversations/phases";
import type { PhaseTransition } from "@/conversations/types";
import type { ToolExecutionResult } from "@/tools/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { NostrPublisher, StreamPublisher } from "@/nostr/NostrPublisher";
import type { ConversationManager } from "@/conversations/ConversationManager";
import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { TracingContext } from "@/tracing";

export interface ExecutionContext {
    agent: AgentInstance;
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
    tracingContext?: TracingContext;
    streamPublisher?: StreamPublisher;
    setStreamPublisher?: (streamPublisher: StreamPublisher) => void;
}

export interface AgentExecutionResult {
    success: boolean;
    response?: string;
    toolExecutions?: ToolExecutionResult[];
    error?: string;
}
