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
    // Process control
    "kill", // All agents should be able to terminate processes
    // Skills management
    "skill_list", // All agents can enumerate available skills on demand
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
 * Context-sensitive tools that are auto-injected based on runtime conditions.
 * These should NOT appear in TenexProjectStatus (24010) events since they're
 * not configurable per-agent - they're injected based on execution context.
 */
export const CONTEXT_INJECTED_TOOLS: ToolName[] = [
    // Meta model tool (injected when agent uses a meta model configuration)
    "change_model",
    // Send message (injected when agent has remembered Telegram transport bindings)
    "send_message",
    // Silent completion is only injected for Telegram-triggered turns
    "no_response",
    // Home filesystem tools (auto-injected as fallbacks when fs_* skills unavailable)
    "home_fs_read",
    "home_fs_write",
    "home_fs_edit",
    "home_fs_glob",
    "home_fs_grep",
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
