import type { AgentCategory } from "@/agents/role-categories";
import type { ToolName } from "@/tools/types";

/**
 * Core tools that ALL agents must have access to regardless of configuration.
 * These are the superset of fundamental capabilities auto-injected by policy.
 * Category-specific policy is applied via getCoreToolsForAgent().
 * NOT announced in 24010 events - auto-injected to all agents.
 */
export const CORE_AGENT_TOOLS: ToolName[] = [
    "lesson_learn", // All agents should be able to learn
    // Todo tool for task tracking
    "todo_write", // All agents should be able to write/update todos
    // Process control
    "kill", // All agents should be able to terminate processes
    // Skills management
    "skill_list", // Most agents can enumerate available skills on demand
    "skills_set", // Most agents can activate/deactivate skills mid-conversation
    // Self-orchestration
    "self_delegate", // All agents can spin up a fresh instance of themselves
] as const;

export const SKILL_MANAGEMENT_TOOLS: ToolName[] = ["skill_list", "skills_set"] as const;

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
 * Get the core auto-injected tools for an agent category.
 *
 * Orchestrators must not activate skills on their own, so skill-management
 * tools are withheld from that category.
 */
export function getCoreToolsForAgent(category?: AgentCategory): ToolName[] {
    if (category !== "orchestrator") {
        return CORE_AGENT_TOOLS;
    }

    return CORE_AGENT_TOOLS.filter((toolName) => !SKILL_MANAGEMENT_TOOLS.includes(toolName));
}

/**
 * Get the delegate tools for an agent.
 * This is the SINGLE source of truth for delegate tool assignment.
 *
 * Domain-expert agents only receive `ask`.
 * Worker agents receive `ask` and `delegate_followup`, but not tools that
 * initiate new delegations.
 */
export function getDelegateToolsForAgent(category?: AgentCategory): ToolName[] {
    const tools: ToolName[] = ["ask"];

    if (category !== "domain-expert") {
        if (category !== "worker") {
            tools.push("delegate");
            tools.push("delegate_crossproject");
        }

        tools.push("delegate_followup");
    }

    return tools;
}

/**
 * Apply category-level delegation policy to a candidate tool list.
 *
 * This is used both during agent hydration and final runtime tool assembly so
 * skills cannot reintroduce delegation tools a category is not allowed to use.
 */
export function filterDelegateToolsForAgentCategory<T extends string>(
    toolNames: T[],
    category?: AgentCategory
): T[] {
    const allowedDelegateTools = new Set(getDelegateToolsForAgent(category));

    return toolNames.filter((toolName) => {
        const typedToolName = toolName as ToolName;
        return !DELEGATE_TOOLS.includes(typedToolName) || allowedDelegateTools.has(typedToolName);
    });
}
