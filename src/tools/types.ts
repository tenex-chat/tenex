import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import type { MCPManager } from "@/services/mcp/MCPManager";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Tool as CoreTool } from "ai";

/**
 * Tool names available in the system.
 * Keep this list in sync with implementations registered in the tool registry.
 */
export type ToolName =
    | "fs_read"
    | "fs_write"
    | "fs_edit"
    | "fs_glob"
    | "fs_grep"
    | "conversation_get"
    | "conversation_list"
    | "lesson_learn"
    | "lesson_get"
    | "shell"
    | "agents_discover"
    | "agents_hire"
    | "agents_list"
    | "agents_read"
    | "agents_write"
    | "agents_publish"
    | "discover_capabilities"
    | "delegate"
    | "delegate_followup"
    | "ask"
    | "project_list"
    | "create_project"
    | "delegate_crossproject"
    | "report_write"
    | "report_read"
    | "reports_list"
    | "report_delete"
    | "schedule_task"
    | "schedule_tasks_list"
    | "schedule_task_cancel"
    | "create_dynamic_tool"
    | "upload_blob"
    | "rag_create_collection"
    | "rag_add_documents"
    | "rag_query"
    | "rag_delete_collection"
    | "rag_list_collections"
    | "rag_subscription_create"
    | "rag_subscription_list"
    | "rag_subscription_get"
    | "rag_subscription_delete"
    | "conversation_search"
    | "bug_list"
    | "bug_report_create"
    | "bug_report_add"
    | "stop_pairing"
    | "todo_add"
    | "todo_update"
    | "web_fetch"
    | "web_search"
    | "nostr_fetch"
    | "change_model";

/**
 * AI SDK tool with optional human-readable formatter and side effect declaration.
 */
export type AISdkTool<TInput = unknown, TOutput = unknown> = CoreTool<TInput, TOutput> & {
    getHumanReadableContent?: (args: TInput) => string;
    /**
     * Whether this tool has side effects (modifies state, writes files, sends messages, etc.)
     * Default is true (assume side effects unless explicitly declared false).
     * Read-only tools (queries, reads) should set this to false.
     */
    hasSideEffects?: boolean;
};

/**
 * Minimal agent surface needed by tools.
 */
export type ToolAgentInfo = Pick<
    AgentInstance,
    "name" | "pubkey" | "slug" | "signer" | "sign" | "llmConfig" | "tools"
>;

/**
 * Base execution environment - available before RAL/publisher setup.
 * This is the minimal context available at any lifecycle stage.
 */
export interface ExecutionEnvironment {
    agent: ToolAgentInfo;
    conversationId: string;
    /**
     * Project directory (normal git repository root).
     * Example: ~/tenex/{dTag}
     */
    projectBasePath: string;
    /**
     * Working directory for code execution.
     * - Default branch: same as projectBasePath (~/tenex/{dTag})
     * - Feature branch: ~/tenex/{dTag}/.worktrees/feature_branch/
     */
    workingDirectory: string;
    /**
     * Current git branch name.
     * Example: "master", "feature/branch-name", "research/foo"
     */
    currentBranch: string;
    triggeringEvent: NDKEvent;
    /**
     * Access to conversation state. May return undefined before full execution setup.
     */
    getConversation: () => ConversationStore | undefined;
    /**
     * Mutable reference to the active tools object used by the LLM service.
     * Tools created via create_dynamic_tool can inject themselves here
     * to become immediately available in the current streaming session.
     */
    activeToolsObject?: Record<string, CoreTool<unknown, unknown>>;
}

/**
 * Runtime tool context - available after prepareExecution().
 * Tools that publish events or need RAL state use this type.
 * All runtime dependencies are REQUIRED, not optional.
 */
export interface ToolExecutionContext extends ExecutionEnvironment {
    agentPublisher: AgentPublisher;
    ralNumber: number;
}

/**
 * Extended context for tools that require conversation state.
 * Tools like todo_add, todo_update, conversation_get (current conversation) need this.
 */
export interface ConversationToolContext extends ToolExecutionContext {
    getConversation: () => ConversationStore;
    conversationStore: ConversationStore;
}

/**
 * Full registry context for tool selection/injection logic.
 * Used by getToolsObject() during actual execution.
 * Extends ConversationToolContext because normal execution always has a conversation.
 */
export interface ToolRegistryContext extends ConversationToolContext {
    alphaMode?: boolean;
    hasActivePairings?: boolean;
    mcpManager?: MCPManager;
}

/**
 * Context for MCP tool execution - explicitly lacks conversation.
 * Tools requiring conversation are filtered out when this context is used.
 */
export interface MCPToolContext extends Omit<ToolExecutionContext, 'getConversation' | 'conversationId' | 'triggeringEvent'> {
    getConversation: () => undefined;
    conversationId?: undefined;
    triggeringEvent?: undefined;
}

export interface ToolError {
    kind: "validation" | "execution" | "system";
    message: string;
    field?: string;
    tool?: string;
}

export interface ToolExecutionResult {
    success: boolean;
    duration: number;
    toolName: string;
    toolArgs: Record<string, unknown>;
    output?: unknown;
    error?: ToolError;
}

/**
 * Tool factory for tools that work without conversation context (MCP-safe).
 */
export type ToolFactory = (context: ToolExecutionContext) => AISdkTool<unknown, unknown>;

/**
 * Tool factory for tools that require conversation context.
 * These tools are filtered out when no conversation is available (e.g., MCP).
 */
export type ConversationToolFactory = (context: ConversationToolContext) => AISdkTool<unknown, unknown>;
