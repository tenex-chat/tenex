import type { AgentInstance } from "@/agents/types";
import type { Conversation, ConversationCoordinator } from "@/conversations";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import type { NDKEvent, NDKPrivateKeySigner, NDKProject } from "@nostr-dev-kit/ndk";

export interface ExecutionContext {
    agent: AgentInstance;
    conversationId: string;
    projectPath: string; // Base project path (e.g., ~/tenex/{dTag}/main)
    workingDirectory: string; // Actual working directory - worktree path (e.g., ~/tenex/{dTag}/feature-branch)
    currentBranch: string; // Current git branch/worktree name (e.g., "main" or "feature-branch")
    triggeringEvent: NDKEvent;
    conversationCoordinator: ConversationCoordinator;
    agentPublisher?: AgentPublisher; // Injected by AgentExecutor - shared publisher instance for consistent event ordering
    isDelegationCompletion?: boolean; // True when agent is reactivated after a delegated task completes
    additionalSystemMessage?: string; // System message to add for retries (used by AgentSupervisor)
    debug?: boolean; // True when running in debug mode - enables additional output like event IDs

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
