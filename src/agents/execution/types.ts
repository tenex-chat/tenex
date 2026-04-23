import type { Tool as CoreTool, ModelMessage, ToolChoice } from "ai";
import type { AgentInstance } from "@/agents/types";
import type { MessageCompiler } from "@/agents/execution/MessageCompiler";
import type { RuntimePromptOverlay } from "@/agents/execution/prompt-history";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import type { AgentRuntimePublisher } from "@/events/runtime/AgentRuntimePublisher";
import type { CompleteEvent } from "@/llm/types";
import type { LLMRequestAnalysisSeed } from "@/llm/types";
import type { MCPManager } from "@/services/mcp/MCPManager";
import type { ToolRegistryContext } from "@/tools/types";
import type { SharedV3ProviderOptions as ProviderOptions } from "@ai-sdk/provider";

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
    triggeringEnvelope: InboundEnvelope;
    getConversation: () => ConversationStore | undefined;

    // Runtime dependencies - added by prepareExecution()
    agentPublisher?: AgentRuntimePublisher;
    ralNumber?: number;
    conversationStore?: ConversationStore;

    /**
     * RAL number pre-claimed by the dispatcher for this execution.
     *
     * When set, `AgentExecutor.execute()` passes this to `resolveRAL` as
     * `preferredRalNumber`, forcing it to resume that specific RAL rather
     * than independently re-discovering one. This is part of the
     * serialization contract that prevents two concurrent dispatches from
     * both resuming the same idle RAL (see RALRegistry.tryAcquireResumptionClaim).
     *
     * The matching release token is held by the caller, not passed here. The
     * caller releases it if execution setup fails before the stream can take
     * ownership.
     */
    preferredRalNumber?: number;

    /**
     * Opaque claim token for the pre-claimed RAL, paired with
     * `preferredRalNumber`. The StreamExecutionHandler uses this to call
     * `handOffResumptionClaimToStream` at the moment it flips `isStreaming`
     * to true — at that point the stream becomes the authoritative owner of
     * the RAL's busy state and the claim token is no longer needed.
     *
     * Only consumed on the FIRST stream invocation. Supervision re-engagement
     * re-enters `executeStreaming` without a token (the original claim has
     * already been handed off by then).
     */
    preferredRalClaimToken?: string;

    // Execution flags
    isDelegationCompletion?: boolean;
    hasPendingDelegations?: boolean;
    debug?: boolean;
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
    pendingContextManagementUsageReporter?: (
        actualInputTokens: number | null | undefined
    ) => Promise<void>;
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
    cachedSystemPrompt?: string;
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

export interface LLMModelRequest {
    messages: ModelMessage[];
    providerOptions?: ProviderOptions;
    experimentalContext?: unknown;
    toolChoice?: ToolChoice<Record<string, CoreTool>>;
    runtimeOverlays?: RuntimePromptOverlay[];
    analysisRequestSeed?: LLMRequestAnalysisSeed;
    reportContextManagementUsage?: (
        actualInputTokens: number | null | undefined
    ) => Promise<void>;
}
