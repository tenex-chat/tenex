/**
 * Skill Tool Permissions Utility
 *
 * Stateless helpers for inspecting tool permissions declared in a skill's
 * SKILL.md frontmatter. Skills can modify an agent's available tools through
 * three keys:
 *
 * 1. only-tools: Highest priority - REPLACES all tools with only these
 * 2. allow-tools: Adds tools to the agent's default set
 * 3. deny-tools: Removes tools from the agent's default set
 *
 * Precedence: only-tools > allow-tools/deny-tools
 */

import type { SkillToolPermissions } from "./types";

export function isOnlyToolMode(permissions: SkillToolPermissions): boolean {
    return Array.isArray(permissions.onlyTools) && permissions.onlyTools.length > 0;
}

export function hasToolPermissions(permissions: SkillToolPermissions): boolean {
    return (
        isOnlyToolMode(permissions) ||
        (Array.isArray(permissions.allowTools) && permissions.allowTools.length > 0) ||
        (Array.isArray(permissions.denyTools) && permissions.denyTools.length > 0)
    );
}
