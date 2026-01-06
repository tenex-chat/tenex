import type { ModelMessage } from "ai";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { CompleteEvent } from "@/llm/service";
import type { ToolRegistryContext } from "@/tools/types";
import type { NDKPrivateKeySigner, NDKProject } from "@nostr-dev-kit/ndk";

export interface ExecutionContext extends ToolRegistryContext {
    agent: AgentInstance;
    isDelegationCompletion?: boolean; // True when agent is reactivated after a delegated task completes
    hasPendingDelegations?: boolean; // True when there are still pending delegations (partial completion)
    debug?: boolean; // True when running in debug mode - enables additional output like event IDs
    conversationStore?: ConversationStore; // Single source of truth for conversation state - injected by AgentExecutor during execution
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

/**
 * Result of executeStreaming - discriminated union for clear error handling.
 * - 'complete': Stream finished successfully with a completion event
 * - 'error-handled': Stream error occurred and was already published to user
 */
export type StreamExecutionResult =
    | { kind: "complete"; event: CompleteEvent; aborted?: boolean }
    | { kind: "error-handled" };

/**
 * Mutable context for RAL execution state during streaming.
 *
 * Makes explicit the state that coordinates between prepareStep and onStopCheck
 * callbacks. Previously this was implicit closure variables.
 */
export interface RALExecutionContext {
    /**
     * Messages accumulated from prepareStep callbacks.
     * Updated in prepareStep (before each LLM step), read in onStopCheck.
     * Contains messages up to but not including the current step.
     */
    accumulatedMessages: ModelMessage[];
}
