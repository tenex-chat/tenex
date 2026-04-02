/**
 * Skill Tool Permissions Utility
 *
 * Stateless utility functions for extracting and querying tool permissions
 * from skill events. Skills can modify an agent's available tools through
 * three tag types:
 *
 * 1. only-tool: Highest priority - REPLACES all tools with only these
 * 2. allow-tool: Adds tools to the agent's default set
 * 3. deny-tool: Removes tools from the agent's default set
 *
 * Precedence: only-tool > allow-tool/deny-tool
 */

import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { getTagValues } from "@/nostr/TagExtractor";
import type { SkillToolPermissions } from "./types";

/**
 * Extract tool permissions from skill events.
 * Collects all only-tool, allow-tool, and deny-tool tags across all skills,
 * deduplicates, and returns aggregated permissions.
 *
 * @param events Array of skill events to extract permissions from
 * @returns Aggregated tool permissions
 */
export function extractToolPermissions(events: NDKEvent[]): SkillToolPermissions {
    const permissions: SkillToolPermissions = {};

    const onlyTools: string[] = [];
    const allowTools: string[] = [];
    const denyTools: string[] = [];

    for (const event of events) {
        const onlyToolValues = getTagValues(event, "only-tool");
        onlyTools.push(...onlyToolValues);

        const allowToolValues = getTagValues(event, "allow-tool");
        allowTools.push(...allowToolValues);

        const denyToolValues = getTagValues(event, "deny-tool");
        denyTools.push(...denyToolValues);
    }

    // Only set arrays if they have values (to keep the object clean)
    if (onlyTools.length > 0) {
        permissions.onlyTools = [...new Set(onlyTools)];
    }
    if (allowTools.length > 0) {
        permissions.allowTools = [...new Set(allowTools)];
    }
    if (denyTools.length > 0) {
        permissions.denyTools = [...new Set(denyTools)];
    }

    return permissions;
}

/**
 * Check if skill permissions are using only-tool mode (highest priority).
 * In only-tool mode, the agent gets EXACTLY the specified tools and nothing else.
 */
export function isOnlyToolMode(permissions: SkillToolPermissions): boolean {
    return Array.isArray(permissions.onlyTools) && permissions.onlyTools.length > 0;
}

/**
 * Check if skill permissions have any tool modifications
 */
export function hasToolPermissions(permissions: SkillToolPermissions): boolean {
    return (
        isOnlyToolMode(permissions) ||
        (Array.isArray(permissions.allowTools) && permissions.allowTools.length > 0) ||
        (Array.isArray(permissions.denyTools) && permissions.denyTools.length > 0)
    );
}

/**
 * Merge tool permissions from frontmatter into an existing SkillToolPermissions object.
 * Used when loading local skills whose permissions are persisted in SKILL.md frontmatter.
 */
export function mergeToolPermissionsFromFrontmatter(
    target: SkillToolPermissions,
    frontmatter: { onlyTools?: string[]; allowTools?: string[]; denyTools?: string[] }
): void {
    if (frontmatter.onlyTools && frontmatter.onlyTools.length > 0) {
        const merged = [...(target.onlyTools ?? []), ...frontmatter.onlyTools];
        target.onlyTools = [...new Set(merged)];
    }
    if (frontmatter.allowTools && frontmatter.allowTools.length > 0) {
        const merged = [...(target.allowTools ?? []), ...frontmatter.allowTools];
        target.allowTools = [...new Set(merged)];
    }
    if (frontmatter.denyTools && frontmatter.denyTools.length > 0) {
        const merged = [...(target.denyTools ?? []), ...frontmatter.denyTools];
        target.denyTools = [...new Set(merged)];
    }
}
