/**
 * ConfigResolver - Utility module for resolving effective agent configuration.
 *
 * Handles the merging of default config with project-scoped delta overrides.
 *
 * ## Tool Delta Syntax
 * Project overrides can use delta syntax for tools:
 * - "+tool" - add this tool on top of defaults
 * - "-tool" - remove this tool from defaults
 * - Plain "tool" (no prefix) - full replacement (entire list is the effective tools)
 *
 * If any tool uses delta syntax, the whole list is treated as delta.
 * If no tool uses delta syntax, the whole list is a full replacement.
 *
 * ## Dedup Logic
 * When a project override field is identical to the default, the override is cleared.
 * This keeps overrides minimal and avoids redundant entries.
 *
 * @example
 * const resolver = new ConfigResolver({
 *   defaultConfig: { model: 'modelA', tools: ['tool1', 'tool2'] },
 *   projectOverrides: {
 *     projectA: { model: 'modelB', tools: ['-tool1', '+tool4'] },
 *     projectB: { tools: ['+tool5'] }
 *   }
 * });
 *
 * // projectA: model=modelB, tools=[tool2, tool4]
 * resolver.resolveEffectiveConfig('projectA');
 *
 * // projectB: model=modelA (default), tools=[tool1, tool2, tool5]
 * resolver.resolveEffectiveConfig('projectB');
 */

import type { AgentDefaultConfig, AgentProjectConfig } from "@/agents/types";
export type { AgentDefaultConfig, AgentProjectConfig };

export interface ResolvedAgentConfig {
    /** The effective model for this project context */
    model?: string;
    /** The effective tools list (fully resolved, no +/- prefixes) */
    tools?: string[];
    /** Skill IDs always active for this agent after default/project resolution. Local skill directory IDs are authoritative. */
    skills?: string[];
    /** Skill IDs blocked from activation after default/project resolution. */
    blockedSkills?: string[];
    /** MCP server slugs this agent can access after default/project resolution. */
    mcpAccess?: string[];
}

/**
 * Apply delta tools to a base tool list.
 * "+tool" adds, "-tool" removes. Order: apply removals first, then additions.
 *
 * @param baseTools - The default tools to apply delta to
 * @param delta - Array of tools with "+"/"-" prefixes
 * @returns The resolved tool list
 */
export function applyToolsDelta(baseTools: string[], delta: string[]): string[] {
    const removals = new Set(
        delta.filter((t) => t.startsWith("-")).map((t) => t.slice(1))
    );
    const additions = delta.filter((t) => t.startsWith("+")).map((t) => t.slice(1));

    const result = baseTools.filter((t) => !removals.has(t));

    for (const tool of additions) {
        if (!result.includes(tool)) {
            result.push(tool);
        }
    }

    return result;
}

/**
 * Resolve the effective tools for a project given defaults and a project override.
 *
 * @param defaultTools - Default tools from agent's default config
 * @param projectTools - Override from project config (may use delta syntax or be full replacement)
 * @returns The effective tools list
 */
export function resolveEffectiveTools(
    defaultTools: string[] | undefined,
    projectTools: string[] | undefined
): string[] | undefined {
    if (!projectTools || projectTools.length === 0) {
        return defaultTools;
    }

    const base = defaultTools ?? [];
    return applyToolsDelta(base, projectTools);
}

/**
 * Resolve the effective model for a project given defaults and a project override.
 *
 * @param defaultModel - Default model from agent's default config
 * @param projectModel - Override from project config
 * @returns The effective model
 */
export function resolveEffectiveModel(
    defaultModel: string | undefined,
    projectModel: string | undefined
): string | undefined {
    return projectModel ?? defaultModel;
}

/**
 * Resolve the effective always-on skills for a project given defaults and a project override.
 *
 * Unlike tools, skills use direct replacement semantics for project overrides:
 * - undefined project skills => use defaults
 * - [] project skills => explicitly disable all always-on skills in this project
 */
export function resolveEffectiveSkills(
    defaultSkills: string[] | undefined,
    projectSkills: string[] | undefined
): string[] | undefined {
    return projectSkills ?? defaultSkills;
}

/**
 * Resolve the effective blocked skills for a project given defaults and a project override.
 *
 * Blocked skills use additive union semantics:
 * - undefined project blockedSkills => use defaults
 * - [] project blockedSkills => still use defaults
 * - project entries add to the default blocked set and can never remove default blocks
 */
export function resolveEffectiveBlockedSkills(
    defaultBlockedSkills: string[] | undefined,
    projectBlockedSkills: string[] | undefined
): string[] | undefined {
    if (!defaultBlockedSkills && !projectBlockedSkills) {
        return undefined;
    }

    return [...new Set([
        ...(defaultBlockedSkills ?? []),
        ...(projectBlockedSkills ?? []),
    ])];
}

/**
 * Resolve the effective MCP server access for a project given defaults and a project override.
 *
 * Uses direct replacement semantics (like skills):
 * - undefined project mcpAccess => use defaults
 * - [] project mcpAccess => explicitly disable all MCP access in this project
 */
export function resolveEffectiveMcpAccess(
    defaultMcpAccess: string[] | undefined,
    projectMcpAccess: string[] | undefined
): string[] | undefined {
    return projectMcpAccess ?? defaultMcpAccess;
}

/**
 * Resolve the full effective config for an agent in a specific project context.
 */
export function resolveEffectiveConfig(
    defaultConfig: AgentDefaultConfig,
    projectConfig: AgentProjectConfig | undefined
): ResolvedAgentConfig {
    const effectiveModel = resolveEffectiveModel(defaultConfig.model, projectConfig?.model);
    const effectiveTools = resolveEffectiveTools(defaultConfig.tools, projectConfig?.tools);
    const effectiveSkills = resolveEffectiveSkills(defaultConfig.skills, projectConfig?.skills);
    const effectiveBlockedSkills = resolveEffectiveBlockedSkills(
        defaultConfig.blockedSkills,
        projectConfig?.blockedSkills
    );
    const effectiveMcpAccess = resolveEffectiveMcpAccess(defaultConfig.mcpAccess, projectConfig?.mcpAccess);

    return {
        model: effectiveModel,
        tools: effectiveTools,
        skills: effectiveSkills,
        blockedSkills: effectiveBlockedSkills,
        mcpAccess: effectiveMcpAccess,
    };
}

/**
 * Compute the minimal delta representation of a full tool list relative to a set of defaults.
 *
 * This is the inverse of applyToolsDelta: given a desired full list and the current defaults,
 * produce the smallest delta (+tool/-tool) that when applied to defaults yields the desired list.
 *
 * Used when storing project-scoped tool overrides: kind 24020 events carry a full list,
 * but the storage layer stores deltas for project overrides.
 *
 * ## Algorithm
 * - Tools in desired but NOT in defaults → "+tool" additions
 * - Tools in defaults but NOT in desired → "-tool" removals
 * - Tools in both → no entry needed (they're already in defaults)
 *
 * @param defaultTools - The agent's default tools list
 * @param desiredTools - The full tool list to achieve
 * @returns Delta array (may contain "+tool" and "-tool" entries), or empty array if no change
 */
export function computeToolsDelta(defaultTools: string[], desiredTools: string[]): string[] {
    const defaultSet = new Set(defaultTools);
    const desiredSet = new Set(desiredTools);

    const delta: string[] = [];

    // Tools to remove: in defaults but not in desired
    for (const tool of defaultTools) {
        if (!desiredSet.has(tool)) {
            delta.push(`-${tool}`);
        }
    }

    // Tools to add: in desired but not in defaults
    for (const tool of desiredTools) {
        if (!defaultSet.has(tool)) {
            delta.push(`+${tool}`);
        }
    }

    return delta;
}

/**
 * Deduplicate a project config against the default config.
 *
 * If a project override value is identical to the effective default, remove it
 * from the override (it's redundant). This keeps overrides minimal.
 *
 * For tools: we compare the fully-resolved tool list. If the resolved tools
 * equal the default tools, clear the project override.
 *
 * Also handles no-op delta dedup: if a stored delta becomes a no-op against
 * the current defaults (e.g., "+tool" where tool is already in defaults),
 * it is cleaned up since the user is explicitly confirming the tool should be available.
 *
 * @param defaultConfig - Agent's default config
 * @param projectConfig - Project override config to deduplicate
 * @returns Cleaned project config (may be empty object if all fields were identical to default)
 */
export function deduplicateProjectConfig(
    defaultConfig: AgentDefaultConfig,
    projectConfig: AgentProjectConfig
): AgentProjectConfig {
    const cleaned: AgentProjectConfig = { ...projectConfig };

    // Dedup model: if project model == default model, clear it
    if (cleaned.model !== undefined && cleaned.model === defaultConfig.model) {
        cleaned.model = undefined;
    }

    // Dedup tools: resolve, normalize delta, and compare
    if (cleaned.tools !== undefined) {
        const defaultToolsResolved = defaultConfig.tools ?? [];
        const resolvedProjectTools = resolveEffectiveTools(defaultConfig.tools, cleaned.tools);

        // Compare resolved tools to default tools (order-insensitive)
        if (arraysEqualUnordered(resolvedProjectTools ?? [], defaultToolsResolved)) {
            cleaned.tools = undefined;
        } else {
            // Normalize: recompute the minimal delta from the fully-resolved tool list.
            cleaned.tools = computeToolsDelta(defaultToolsResolved, resolvedProjectTools ?? []);
        }
    }

    // Dedup skills: a project-scoped skill list is redundant if it matches defaults.
    if (cleaned.skills !== undefined) {
        const defaultSkills = defaultConfig.skills ?? [];
        if (arraysEqualUnordered(cleaned.skills, defaultSkills)) {
            cleaned.skills = undefined;
        }
    }

    // Dedup blockedSkills: union semantics mean project entries already in defaults are redundant.
    if (cleaned.blockedSkills !== undefined) {
        const defaultBlockedSkills = new Set(defaultConfig.blockedSkills ?? []);
        const uniqueProjectBlockedSkills = [...new Set(cleaned.blockedSkills)].filter(
            (skillId) => !defaultBlockedSkills.has(skillId)
        );

        cleaned.blockedSkills = uniqueProjectBlockedSkills.length > 0
            ? uniqueProjectBlockedSkills
            : undefined;
    }

    // Dedup mcpAccess: a project-scoped list is redundant if it matches defaults.
    if (cleaned.mcpAccess !== undefined) {
        const defaultMcpAccess = defaultConfig.mcpAccess ?? [];
        if (arraysEqualUnordered(cleaned.mcpAccess, defaultMcpAccess)) {
            cleaned.mcpAccess = undefined;
        }
    }

    return cleaned;
}

/**
 * Check if two arrays contain the same elements in the same order.
 */
export function arraysEqual<T>(a: T[], b: T[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Check if two arrays contain the same elements (order-independent).
 * Used for tool list comparison where order doesn't matter for dedup.
 */
export function arraysEqualUnordered<T>(a: T[], b: T[]): boolean {
    if (a.length !== b.length) return false;
    const setA = new Set(a);
    const setB = new Set(b);
    if (setA.size !== setB.size) return false;
    for (const item of setA) {
        if (!setB.has(item)) return false;
    }
    return true;
}
