import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
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
