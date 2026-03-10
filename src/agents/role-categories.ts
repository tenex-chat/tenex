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
 * Legacy category names mapped to their new taxonomy equivalents.
 * Used for backward compatibility with existing agent definitions.
 */
const LEGACY_CATEGORY_MAP = {
    executor: "worker",
    expert: "domain-expert",
    advisor: "reviewer",
    creator: "generalist",
    assistant: "generalist",
} as const satisfies Record<string, AgentCategory>;

/**
 * Type for legacy category strings that can be resolved to current categories.
 */
export type LegacyCategory = keyof typeof LEGACY_CATEGORY_MAP;

/**
 * Check if a string is a valid current agent category (does NOT accept legacy names).
 */
export function isValidCategory(value: string): value is AgentCategory {
    return VALID_CATEGORIES.includes(value as AgentCategory);
}

/**
 * Check if a string is a recognized category — either current or legacy.
 * Use `resolveCategory` to map legacy values to their current equivalents.
 */
export function isKnownCategory(value: string): value is AgentCategory | LegacyCategory {
    return VALID_CATEGORIES.includes(value as AgentCategory) || Object.hasOwn(LEGACY_CATEGORY_MAP, value);
}

/**
 * Resolve an agent's effective category.
 * Returns the category if valid and provided, otherwise undefined.
 * Migrates legacy category names to the new taxonomy.
 *
 * Categories are for semantic classification and organizational purposes only.
 * They do not restrict tool access — all agents have access to all tools.
 */
export function resolveCategory(category: string | undefined): AgentCategory | undefined {
    if (!category) return undefined;

    if (VALID_CATEGORIES.includes(category as AgentCategory)) {
        return category as AgentCategory;
    }

    if (Object.hasOwn(LEGACY_CATEGORY_MAP, category)) {
        return LEGACY_CATEGORY_MAP[category as LegacyCategory];
    }

    return undefined;
}
