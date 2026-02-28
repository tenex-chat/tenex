import type { ToolName } from "@/tools/types";

/**
 * Core tools that ALL agents must have access to regardless of configuration.
 * These are fundamental capabilities that every agent needs.
 * NOT announced in 24010 events - auto-injected to all agents.
 */
export const CORE_AGENT_TOOLS: ToolName[] = [
    "lesson_get", // All agents should access lessons
    "lessons_list", // All agents should be able to list lessons
    "lesson_learn", // All agents should be able to learn
    "lesson_delete", // All agents should be able to delete their lessons
    "reports_list", // All agents should see available reports
    "report_read", // All agents should read reports
    "report_write", // All agents should be able to write reports
    "report_delete", // All agents should be able to delete reports
    // Todo tool for task tracking
    "todo_write", // All agents should be able to write/update todos
    // Conversation tools for project introspection
    "conversation_get", // All agents should access conversation details
    "conversation_list", // All agents should list conversations
    // RAG tools for knowledge management
    "rag_search", // All agents should be able to search across reports, conversations, and lessons
    "rag_create_collection", // All agents should be able to create RAG collections
    "rag_add_documents", // All agents should be able to add documents to collections
    "rag_delete_collection", // All agents should be able to delete RAG collections
    "rag_list_collections", // All agents should be able to list RAG collections
    "rag_subscription_create", // All agents should be able to create RAG subscriptions
    "rag_subscription_list", // All agents should be able to list RAG subscriptions
    "rag_subscription_get", // All agents should be able to get RAG subscription details
    "rag_subscription_delete", // All agents should be able to delete RAG subscriptions
    // Process control
    "kill", // All agents should be able to terminate processes
    // MCP resource reading and subscriptions (self-gating: only works if agent has MCP tools from that server)
    "mcp_resource_read", // All agents can read MCP resources from servers they have tools for
    "mcp_subscribe", // All agents can subscribe to MCP resource notifications
] as const;

/**
 * Delegate tools that should be excluded from configuration and TenexProjectStatus events
 */
export const DELEGATE_TOOLS: ToolName[] = [
    "ask",
    "delegate",
    "delegate_crossproject",
    "delegate_followup",
] as const;


/**
 * Tools auto-injected at runtime based on capability (not announced in 24010).
 * fs_read implies fs_glob + fs_grep; fs_write implies fs_edit.
 */
export const AUTO_INJECTED_TOOLS: ToolName[] = ["fs_edit", "fs_glob", "fs_grep"];

/**
 * Context-sensitive tools that are auto-injected based on runtime conditions.
 * These should NOT appear in TenexProjectStatus (24010) events since they're
 * not configurable per-agent - they're injected based on execution context.
 */
export const CONTEXT_INJECTED_TOOLS: ToolName[] = [
    // Meta model tool (injected when agent uses a meta model configuration)
    "change_model",
    // Home-scoped filesystem tools (injected when agent lacks fs_* tools)
    "home_fs_read",
    "home_fs_write",
    "home_fs_grep",
    // MCP subscription stop (injected when agent has active MCP subscriptions)
    "mcp_subscription_stop",
];

/**
 * Get the delegate tools for an agent
 * This is the SINGLE source of truth for delegate tool assignment
 */
export function getDelegateToolsForAgent(): ToolName[] {
    const tools: ToolName[] = [];

    // All agents get ask tool
    tools.push("ask");

    // All agents get the unified delegate tool
    tools.push("delegate");

    // All agents get delegate_crossproject and delegate_followup
    tools.push("delegate_crossproject");
    tools.push("delegate_followup");

    return tools;
}
