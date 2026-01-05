import type { ExecutionContext } from "@/agents/execution/types";
import type { Tool as CoreTool } from "ai";

/**
 * Tool names available in the system.
 * Keep this list in sync with implementations registered in the tool registry.
 */
export type ToolName =
    | "read_path"
    | "write_file"
    | "edit"
    | "codebase_search"
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
    | "discover_capabilities"
    | "delegate"
    | "delegate_followup"
    | "ask"
    | "project_list"
    | "create_project"
    | "delegate_external"
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
    | "nostr_fetch";

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
 * Execution context exposed to tools/tests.
 */
export type ToolContext = ExecutionContext;

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
 * Tool factory signature used when registering tools.
 */
export type ToolFactory = (context: ExecutionContext) => AISdkTool<unknown, unknown>;
