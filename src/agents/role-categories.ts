/**
 * role-categories - Semantic classification for agents
 *
 * Agents have an optional `category` field for semantic classification and organizational purposes.
 * Categories do NOT restrict tool access — all agents have access to all tools.
 *
 * Categories represent operational roles:
 * - `principal`      — The human (e.g., human-replica)
 * - `orchestrator`   — Routes work, coordinates (e.g., PMs, coordinators)
 * - `worker`         — Does the work (e.g., developers, implementers)
 * - `reviewer`       — Evaluates quality, validates plans (e.g., clean-code-nazi)
 * - `domain-expert`  — Deep domain knowledge (e.g., ndk-core-expert)
 * - `generalist`     — General-purpose helpers
 *
 * Unknown/missing category remains undefined. Only set a category when explicitly known.
 */

/**
 * Valid agent categories.
 */
export type AgentCategory = "principal" | "orchestrator" | "worker" | "reviewer" | "domain-expert" | "generalist";


/**
 * All recognized category values for validation.
 */
export const VALID_CATEGORIES: readonly AgentCategory[] = [
    "principal",
    "orchestrator",
    "worker",
    "reviewer",
    "domain-expert",
    "generalist",
] as const;

/**
 * Check if a string is a valid current agent category.
 */
export function isValidCategory(value: string): value is AgentCategory {
    return VALID_CATEGORIES.includes(value as AgentCategory);
}

/**
 * Resolve an agent's effective category.
 * Returns the category if valid, otherwise undefined.
 *
 * Categories are for semantic classification and organizational purposes only.
 * They do not restrict tool access — all agents have access to all tools.
 */
export function resolveCategory(category: string | undefined): AgentCategory | undefined {
    if (!category) return undefined;

    if (VALID_CATEGORIES.includes(category as AgentCategory)) {
        return category as AgentCategory;
    }

    return undefined;
}
