import type { AgentInstance } from "@/agents/types";
import type { Conversation, ConversationCoordinator } from "@/conversations";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import type { NDKEvent, NDKPrivateKeySigner, NDKProject } from "@nostr-dev-kit/ndk";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";

export interface ExecutionContext {
  agent: AgentInstance;
  conversationId: string;
  projectPath: string;
  triggeringEvent: NDKEvent;
  conversationCoordinator: ConversationCoordinator;
  agentPublisher: AgentPublisher; // Required: shared publisher instance for consistent event ordering
  isDelegationCompletion?: boolean; // True when agent is reactivated after a delegated task completes
  additionalSystemMessage?: string; // System message to add for retries (used by AgentSupervisor)

  /**
   * Helper method to get the conversation for this context
   */
  getConversation(): Conversation | undefined;
}

/**
 * Minimal context for standalone agent execution
 */
export interface StandaloneAgentContext {
  agents: Map<string, AgentInstance>;
  pubkey: string;
  signer: NDKPrivateKeySigner;
  project?: NDKProject;
  getLessonsForAgent?: (pubkey: string) => NDKAgentLesson[];
}
