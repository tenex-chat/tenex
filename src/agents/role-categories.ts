/**
 * role-categories - Semantic classification for agents
 *
 * Agents have an optional `category` field for semantic classification and organizational purposes.
 * Categories do NOT restrict tool access — all agents have access to all tools.
 *
 * Categories represent operational roles:
 * - `principal`    — Human proxy (e.g., human-replica)
 * - `orchestrator` — PMs, coordinators
 * - `worker`       — Developers, implementers
 * - `advisor`      — Experts, reviewers
 * - `auditor`      — Testers, code reviewers
 *
 * Unknown/missing category defaults to `principal` (unrestricted).
 */

/**
 * Valid agent categories.
 */
export type AgentCategory = "principal" | "orchestrator" | "worker" | "advisor" | "auditor";

/**
 * The default category applied when an agent has no recognized category.
 * Defaults to "principal" (unrestricted).
 */
export const DEFAULT_CATEGORY: AgentCategory = "principal";

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
 * Returns the category if valid, otherwise the default (principal).
 *
 * Categories are for semantic classification and organizational purposes only.
 * They do not restrict tool access — all agents have access to all tools.
 */
export function resolveCategory(category: string | undefined): AgentCategory {
    if (category && isValidCategory(category)) {
        return category;
    }
    return DEFAULT_CATEGORY;
}
