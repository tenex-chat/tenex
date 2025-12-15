import type { AgentInstance } from "@/agents/types";
import type { Conversation, ConversationCoordinator } from "@/conversations";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import type { NDKEvent, NDKPrivateKeySigner, NDKProject } from "@nostr-dev-kit/ndk";

export interface ExecutionContext {
    agent: AgentInstance;
    conversationId: string;
    /**
     * Project directory (normal git repository root).
     * Example: ~/tenex/{dTag}
     * The default branch is checked out here directly.
     */
    projectBasePath: string;
    /**
     * Working directory for code execution.
     * - Default branch: same as projectBasePath (~/tenex/{dTag})
     * - Feature branch: ~/tenex/{dTag}/.worktrees/feature_branch/
     * This is where git commands run and files are edited.
     */
    workingDirectory: string;
    /**
     * Current git branch name.
     * Example: "master", "feature/branch-name", "research/foo"
     */
    currentBranch: string;
    triggeringEvent: NDKEvent;
    conversationCoordinator: ConversationCoordinator;
    agentPublisher?: AgentPublisher; // Injected by AgentExecutor - shared publisher instance for consistent event ordering
    isDelegationCompletion?: boolean; // True when agent is reactivated after a delegated task completes
    additionalSystemMessage?: string; // Continuation message injected as user role for phase/retry handling (used by AgentSupervisor)
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
