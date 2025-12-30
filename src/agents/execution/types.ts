import type { Tool as CoreTool } from "ai";
import type { AgentInstance } from "@/agents/types";
import type { Conversation, ConversationCoordinator } from "@/conversations";
import type { ConversationStore } from "@/conversations/ConversationStore";
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
    hasPendingDelegations?: boolean; // True when there are still pending delegations (partial completion)
    debug?: boolean; // True when running in debug mode - enables additional output like event IDs
    alphaMode?: boolean; // True when running in alpha mode - enables bug reporting tools
    hasConcurrentRALs?: boolean; // True when other RALs are active - enables RAL management tools
    hasActivePairings?: boolean; // True when this agent has active pairing sessions - enables stop_pairing tool
    ralNumber?: number; // The RAL number for this execution - set by AgentExecutor during execution
    conversationStore?: ConversationStore; // Single source of truth for conversation state - injected by AgentExecutor during execution

    /**
     * Reference to the active tools object used by the LLM service.
     * Tools created via create_dynamic_tool can inject themselves here
     * to become immediately available in the current streaming session.
     *
     * Note: This is a mutable reference - modifying it affects the running stream.
     */
    activeToolsObject?: Record<string, CoreTool<unknown, unknown>>;

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
