import type { ModelMessage, Tool as CoreTool } from "ai";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { CompleteEvent } from "@/llm/service";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import type { MCPManager } from "@/services/mcp/MCPManager";
import type { NDKEvent, NDKPrivateKeySigner, NDKProject } from "@nostr-dev-kit/ndk";

/**
 * Execution context for agent runs.
 *
 * This is the context created by createExecutionContext and enriched during execution.
 * Runtime dependencies (agentPublisher, ralNumber, conversationStore) may not be
 * available at creation time - they are added by prepareExecution().
 *
 * When passing context to tools via getToolsObject(), ensure all required fields
 * are present (use ToolRegistryContext type to enforce this).
 */
export interface ExecutionContext {
    agent: AgentInstance;
    conversationId: string;
    projectBasePath: string;
    workingDirectory: string;
    currentBranch: string;
    triggeringEvent: NDKEvent;
    getConversation: () => ConversationStore | undefined;

    // Runtime dependencies - added by prepareExecution()
    agentPublisher?: AgentPublisher;
    ralNumber?: number;
    conversationStore?: ConversationStore;

    // Execution flags
    isDelegationCompletion?: boolean;
    hasPendingDelegations?: boolean;
    debug?: boolean;
    alphaMode?: boolean;
    hasActivePairings?: boolean;
    mcpManager?: MCPManager;

    // Dynamic tool injection
    activeToolsObject?: Record<string, CoreTool<unknown, unknown>>;
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
