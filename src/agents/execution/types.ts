import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations/ConversationCoordinator";
import type { Phase } from "@/conversations/phases";
import type { ToolExecutionResult } from "@/tools/types";
import type { TracingContext } from "@/tracing";

export interface ExecutionContext {
  agent: AgentInstance;
  conversationId: string;
  phase: Phase;
  projectPath: string;
  triggeringEvent: NDKEvent;
  replyTarget?: NDKEvent; // Optional: what to reply to (if different from trigger)
  conversationManager: ConversationCoordinator;
  previousPhase?: Phase;
  claudeSessionId?: string;
  agentExecutor?: AgentExecutor;
  tracingContext?: TracingContext;
  isTaskCompletionReactivation?: boolean; // True when agent is reactivated after delegated task completion
}

export interface AgentExecutionResult {
  success: boolean;
  response?: string;
  toolExecutions?: ToolExecutionResult[];
  error?: string;
}
