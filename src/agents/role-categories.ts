/**
 * role-categories - Maps agent categories to tool restrictions
 *
 * TIP-01: Role-Based Agent Categorization
 *
 * Agents have a `category` field that determines which tools they are denied.
 * Categories represent operational roles, not skills:
 *
 * - `principal`    — Human proxy (e.g., human-replica). No restrictions.
 * - `orchestrator` — PMs, coordinators. Can delegate but shouldn't touch code.
 * - `worker`       — Developers, implementers. Full tool access, no delegation.
 * - `advisor`      — Experts, reviewers. Read-only, no mutation or delegation.
 * - `auditor`      — Testers, code reviewers. Read + limited execution (shell), no writes.
 *
 * Unknown/missing category defaults to `advisor` (most restrictive non-auditor).
 */

/**
 * Valid agent categories.
 */
export type AgentCategory = "principal" | "orchestrator" | "worker" | "advisor" | "auditor";

/**
 * The default category applied when an agent has no recognized category.
 * Defaults to "principal" (unrestricted) for backwards compatibility with agents
 * created before the category field existed. Existing agents should have their
 * category explicitly set based on their operational role.
 */
export const DEFAULT_CATEGORY: AgentCategory = "principal";

/**
 * Map of category → tool names that should be DENIED.
 *
 * Tool names are matched exactly against the tool list.
 * Each tool to deny must be listed individually (e.g., both "fs_write" and "home_fs_write").
 * MCP tools (prefixed with "mcp__") are never denied by category restrictions.
 */
export const CATEGORY_DENIED_TOOLS: Record<AgentCategory, readonly string[]> = {
    principal: [],
    orchestrator: ["fs_write", "fs_edit", "home_fs_write", "shell"],
    worker: [],
    advisor: ["fs_write", "fs_edit", "home_fs_write", "shell"],
    auditor: ["fs_write", "fs_edit", "home_fs_write"],
} as const;

/**
 * All recognized category values for validation.
 */
export const VALID_CATEGORIES: readonly AgentCategory[] = [
    "principal",
    "orchestrator",
    "worker",
    "advisor",
    "auditor",
] as const;

/**
 * Check if a string is a valid agent category.
 */
export function isValidCategory(value: string): value is AgentCategory {
    return VALID_CATEGORIES.includes(value as AgentCategory);
}

/**
 * Resolve an agent's effective category.
 * Returns the category if valid, otherwise the default (advisor).
 */
export function resolveCategory(category: string | undefined): AgentCategory {
    if (category && isValidCategory(category)) {
        return category;
    }
    return DEFAULT_CATEGORY;
}

/**
 * Get the list of denied tool names for a given category.
 */
export function getDeniedTools(category: AgentCategory): readonly string[] {
    return CATEGORY_DENIED_TOOLS[category];
}

/**
 * Filter out denied tools from a tool list based on the agent's category.
 * MCP tools (prefixed with "mcp__") are never filtered — category restrictions
 * only apply to built-in tools.
 *
 * @param tools - The full tool list
 * @param category - The agent's resolved category
 * @returns Tools with denied ones removed
 */
export function filterDeniedTools(tools: string[], category: AgentCategory): string[] {
    const denied = CATEGORY_DENIED_TOOLS[category];
    if (denied.length === 0) return tools;

    return tools.filter((tool) => {
        // Never filter MCP tools by category
        if (tool.startsWith("mcp__")) return true;
        return !denied.includes(tool);
    });
}
