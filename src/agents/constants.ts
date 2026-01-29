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
 * Context-sensitive tools that are auto-injected based on runtime conditions.
 * These should NOT appear in TenexProjectStatus (24010) events since they're
 * not configurable per-agent - they're injected based on execution context.
 */
export const CONTEXT_INJECTED_TOOLS: ToolName[] = [
    // Alpha mode bug reporting tools (injected when alphaMode is true)
    "bug_list",
    "bug_report_create",
    "bug_report_add",
    // Meta model tool (injected when agent uses a meta model configuration)
    "change_model",
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
