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
 *   projectConfigs: {
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

export interface AgentDefaultConfig {
    /** Default LLM model configuration string */
    model?: string;
    /** Default tools list */
    tools?: string[];
}

export interface AgentProjectConfig {
    /** Project-specific model override (or undefined to inherit default) */
    model?: string;
    /** Project-specific tools - can be full replacement or delta (+/-) */
    tools?: string[];
}

export interface ResolvedAgentConfig {
    /** The effective model for this project context */
    model?: string;
    /** The effective tools list (fully resolved, no +/- prefixes) */
    tools?: string[];
}

/**
 * Determines if a tools array uses delta syntax.
 * Delta syntax means at least one tool has a "+" or "-" prefix.
 */
export function isToolsDelta(tools: string[]): boolean {
    return tools.some((t) => t.startsWith("+") || t.startsWith("-"));
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
        // No project-level override - use defaults
        return defaultTools;
    }

    if (isToolsDelta(projectTools)) {
        // Delta syntax - apply on top of defaults
        const base = defaultTools ?? [];
        return applyToolsDelta(base, projectTools);
    }

    // Full replacement
    return projectTools;
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
 * Resolve the full effective config for an agent in a specific project context.
 */
export function resolveEffectiveConfig(
    defaultConfig: AgentDefaultConfig,
    projectConfig: AgentProjectConfig | undefined
): ResolvedAgentConfig {
    const effectiveModel = resolveEffectiveModel(defaultConfig.model, projectConfig?.model);
    const effectiveTools = resolveEffectiveTools(defaultConfig.tools, projectConfig?.tools);

    return {
        model: effectiveModel,
        tools: effectiveTools,
    };
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
        delete cleaned.model;
    }

    // Dedup tools: resolve and compare
    if (cleaned.tools !== undefined) {
        const resolvedProjectTools = resolveEffectiveTools(defaultConfig.tools, cleaned.tools);
        const defaultToolsResolved = defaultConfig.tools ?? [];

        // Compare resolved tools to default tools
        if (arraysEqual(resolvedProjectTools ?? [], defaultToolsResolved)) {
            // Resolved tools are identical to defaults - clear the override
            delete cleaned.tools;
        }
    }

    return cleaned;
}

/**
 * Check if two arrays contain the same elements in the same order.
 */
function arraysEqual<T>(a: T[], b: T[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}
