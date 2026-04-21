/**
 * role-categories - Semantic classification for agents
 *
 * Agents have an optional `category` field for semantic classification and capability policy.
 *
 * Categories represent operational roles:
 * - `principal`      — The human (e.g., human-replica)
 * - `orchestrator`   — Routes work, coordinates (e.g., PMs, coordinators)
 * - `worker`         — Does the work directly (e.g., developers, implementers); no new agent delegation
 * - `reviewer`       — Evaluates quality, validates plans (e.g., clean-code-nazi)
 * - `domain-expert`  — Deep domain knowledge; receives `ask` only — no agent delegation
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
 * The resolved category drives capability policy — e.g., domain-experts
 * receive only `ask`, while workers receive follow-up delegation support
 * without tools that initiate new delegations.
 */
export function resolveCategory(category: string | undefined): AgentCategory | undefined {
    if (!category) return undefined;

    if (VALID_CATEGORIES.includes(category as AgentCategory)) {
        return category as AgentCategory;
    }

    return undefined;
}
