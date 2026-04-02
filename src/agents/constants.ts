import type { ToolName } from "@/tools/types";

/**
 * Core tools that ALL agents must have access to regardless of configuration.
 * These are fundamental capabilities that every agent needs.
 * NOT announced in 24010 events - auto-injected to all agents.
 */
export const CORE_AGENT_TOOLS: ToolName[] = [
    "lesson_learn", // All agents should be able to learn
    // Todo tool for task tracking
    "todo_write", // All agents should be able to write/update todos
    // Filesystem tools for reading and writing project files
    "fs_read", // All agents should be able to read files
    "fs_write", // All agents should be able to write files
    "fs_edit", // All agents should be able to edit files
    "fs_glob", // All agents should be able to find files by pattern
    "fs_grep", // All agents should be able to search file contents
    // Task scheduling
    "schedule_task", // All agents should be able to schedule recurring and one-off tasks
    // Conversation tools for project introspection
    "conversation_get", // All agents should access conversation details
    "conversation_list", // All agents should list conversations
    // Process control
    "kill", // All agents should be able to terminate processes
    // MCP resource reading and subscriptions (self-gating: only works if agent has MCP tools from that server)
    "mcp_resource_read", // All agents can read MCP resources from servers they have tools for
    "mcp_subscribe", // All agents can subscribe to MCP resource notifications
    // Skills management
    "skills_set", // All agents can activate/deactivate skills mid-conversation
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
 * Skill-provided tools that should be excluded from TenexProjectStatus (24010) events.
 * These tools are only accessible via skill activation, not direct agent configuration.
 */
export const SKILL_PROVIDED_TOOLS: ToolName[] = [
    // RAG skill tools
    "rag_search",
    "rag_collection_create",
    "rag_add_documents",
    "rag_collection_delete",
    "rag_collection_list",
    "rag_subscription_create",
    "rag_subscription_list",
    "rag_subscription_get",
    "rag_subscription_delete",
    // Shell skill tools
    "shell",
    // Conversation search skill
    "conversation_search",
    // Nostr skill
    "nostr_publish_as_user",
] as const;


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
    "home_fs_edit",
    "home_fs_grep",
    "home_fs_glob",
    // MCP subscription stop (injected when agent has active MCP subscriptions)
    "mcp_subscription_stop",
    // Send message (injected when agent has remembered Telegram transport bindings)
    "send_message",
    // Silent completion is only injected for Telegram-triggered turns
    "no_response",
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
