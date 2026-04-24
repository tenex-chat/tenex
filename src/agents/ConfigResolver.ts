/**
 * ConfigResolver - Utility module for resolving effective agent configuration.
 *
 * Resolves the effective config from an agent's default config block.
 *
 * ## Tool Delta Syntax
 * Tools can use delta syntax when combining lists:
 * - "+tool" - add this tool on top of a base list
 * - "-tool" - remove this tool from a base list
 * - Plain "tool" (no prefix) - no-op in delta context (treated as addition or base)
 */

import type { AgentDefaultConfig } from "@/agents/types";
export type { AgentDefaultConfig };

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
 * Resolve the full effective config for an agent from its default config.
 */
export function resolveEffectiveConfig(
    defaultConfig: AgentDefaultConfig
): ResolvedAgentConfig {
    return {
        model: defaultConfig.model,
        tools: defaultConfig.tools,
        skills: defaultConfig.skills,
        blockedSkills: defaultConfig.blockedSkills,
        mcpAccess: defaultConfig.mcpAccess,
    };
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
