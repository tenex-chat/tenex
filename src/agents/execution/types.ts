import type { Tool as CoreTool, ModelMessage } from "ai";
import type { AgentInstance } from "@/agents/types";
import type { MessageCompiler } from "@/agents/execution/MessageCompiler";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { CompleteEvent } from "@/llm/types";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import type { MCPManager } from "@/services/mcp/MCPManager";
import type { ToolRegistryContext } from "@/tools/types";
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
    mcpManager?: MCPManager;
}


/**
 * Result of executeStreaming - discriminated union for clear error handling.
 * - 'complete': Stream finished successfully with a completion event
 * - 'error-handled': Stream error occurred and was already published to user
 */
export type StreamExecutionResult =
    | {
          kind: "complete";
          event: CompleteEvent;
          aborted?: boolean;
          /** The reason the execution was aborted (if aborted=true) */
          abortReason?: string;
          messageCompiler: MessageCompiler;
          /** Accumulated LLM runtime in milliseconds (captured before RAL cleanup) */
          accumulatedRuntime: number;
      }
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

/**
 * Full runtime context for executor methods.
 * Extends ToolRegistryContext with:
 * - agent: AgentInstance (full agent type, not just ToolAgentInfo)
 * - Execution-specific flags from ExecutionContext
 */
export type FullRuntimeContext = Omit<ToolRegistryContext, "agent"> & {
    agent: AgentInstance;
    isDelegationCompletion?: boolean;
    hasPendingDelegations?: boolean;
};

/**
 * Request object for LLM completion preparation.
 * Created by prepareLLMRequest() for external callers that need to prepare
 * an LLM request without executing it (e.g., schema extraction).
 */
export interface LLMCompletionRequest {
    messages: ModelMessage[];
    tools?: Record<string, CoreTool>;
}
