import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import type { AgentRuntimePublisher } from "@/events/runtime/AgentRuntimePublisher";
import type { MCPManager } from "@/services/mcp/MCPManager";
import type { ProjectContext } from "@/services/projects/ProjectContext";
import type { Tool as CoreTool } from "ai";

export interface ToolTranscriptArgSpec {
    key: string;
    attribute?: string;
}

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
    | "home_fs_read"
    | "home_fs_write"
    | "home_fs_edit"
    | "home_fs_glob"
    | "home_fs_grep"
    | "conversation_get"
    | "conversation_list"
    | "lesson_learn"
    | "shell"
    | "agents_write"
    | "modify_project"
    | "delegate"
    | "delegate_followup"
    | "self_delegate"
    | "ask"
    | "project_list"
    | "delegate_crossproject"
    | "schedule_task"
    | "rag_collection_create"
    | "rag_add_documents"
    | "rag_search"
    | "rag_collection_delete"
    | "rag_collection_list"
    | "rag_subscription_create"
    | "rag_subscription_list"
    | "rag_subscription_get"
    | "rag_subscription_delete"
    | "mcp_list_resources"
    | "mcp_resource_read"
    | "mcp_subscribe"
    | "mcp_subscription_stop"
    | "conversation_search"
    | "todo_write"
    | "nostr_publish_as_user"
    | "change_model"
    | "kill"
    | "no_response"
    | "skill_list"
    | "skills_set"
    | "send_message";

/**
 * AI SDK tool with optional transcript arg declaration.
 */
export type AISdkTool<TInput = unknown, TOutput = unknown> = CoreTool<TInput, TOutput> & {
    /**
     * Optional list of input argument keys to expose in conversation transcript XML.
     * Keys are read from tool input args at execution time and serialized as XML attributes.
     */
    transcriptArgsToInclude?: ToolTranscriptArgSpec[];
};

/**
 * Minimal agent surface needed by tools.
 */
export type ToolAgentInfo = Pick<
    AgentInstance,
    | "name"
    | "pubkey"
    | "slug"
    | "signer"
    | "sign"
    | "llmConfig"
    | "tools"
    | "telegram"
    | "mcpAccess"
    | "blockedSkills"
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
    triggeringEnvelope: InboundEnvelope;
    /**
     * Access to conversation state. May return undefined before full execution setup.
     */
    getConversation: () => ConversationStore | undefined;
}

/**
 * Runtime tool context - available after prepareExecution().
 * Tools that publish events or need RAL state use this type.
 * All runtime dependencies are REQUIRED, not optional.
 */
export interface ToolExecutionContext extends ExecutionEnvironment {
    agentPublisher: AgentRuntimePublisher;
    ralNumber: number;
    /**
     * Explicit project context for tools that need project association.
     * Required to avoid ALS context bugs in cross-project delegation scenarios.
     */
    projectContext: ProjectContext;
}

/**
 * Extended context for tools that require conversation state.
 * Tools like todo_write, conversation_get (current conversation) need this.
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
    mcpManager?: MCPManager;
    /**
     * Explicit project context for tools that need project association.
     * Required to avoid ALS context bugs in cross-project delegation scenarios.
     */
    projectContext: ProjectContext;
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
export type ConversationToolFactory = (
    context: ConversationToolContext
) => AISdkTool<unknown, unknown>;
