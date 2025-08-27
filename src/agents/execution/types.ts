import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { Phase } from "@/conversations/phases";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import type { ToolExecutionResult } from "@/tools/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

export interface ExecutionContext {
  agent: AgentInstance;
  conversationId: string;
  phase: Phase;
  projectPath: string;
  triggeringEvent: NDKEvent;
  conversationCoordinator: ConversationCoordinator;
  agentPublisher: AgentPublisher; // Required: shared publisher instance for consistent event ordering
  claudeSessionId?: string;
  isDelegationCompletion?: boolean; // True when agent is reactivated after a delegated task completes
}

export interface AgentExecutionResult {
  success: boolean;
  response?: string;
  toolExecutions?: ToolExecutionResult[];
  error?: string;
}
