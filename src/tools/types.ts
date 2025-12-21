import type { ExecutionContext } from "@/agents/execution/types";
import type { Tool as CoreTool } from "ai";

/**
 * Tool names available in the system.
 * Keep this list in sync with implementations registered in the tool registry.
 */
export type ToolName =
    | "read_path"
    | "write_file"
    | "codebase_search"
    | "conversation_get"
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
    | "nostr_projects"
    | "create_project"
    | "delegate_external"
    | "report_write"
    | "report_read"
    | "reports_list"
    | "report_delete"
    | "phase_add"
    | "phase_remove"
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
    | "bug_list"
    | "bug_report_create"
    | "bug_report_add"
    | "restart_tenex_backend";

/**
 * AI SDK tool with optional human-readable formatter.
 */
export type AISdkTool<TInput = unknown, TOutput = unknown> = CoreTool<TInput, TOutput> & {
    getHumanReadableContent?: (args: TInput) => string;
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
