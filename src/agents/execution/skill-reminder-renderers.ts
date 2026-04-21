/**
 * Rendering functions for skill-related system reminders.
 *
 * Extracted from the former prompt fragment `12-skills`.
 * Lives at Layer 3 (agents/) so it can legitimately import from services/skill.
 */

import type { SkillData, SkillToolPermissions } from "@/services/skill";
import { hasToolPermissions, isOnlyToolMode } from "@/services/skill";

// ---------------------------------------------------------------------------
// Loaded-skills rendering (from former 12-skills.ts)
// ---------------------------------------------------------------------------

function escapeAttrValue(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function renderToolPermissionsHeader(permissions: SkillToolPermissions): string {
    if (!hasToolPermissions(permissions)) {
        return "";
    }

    const lines: string[] = [];

    if (isOnlyToolMode(permissions)) {
        lines.push(
            `Your available tools are restricted to: ${permissions.onlyTools?.join(", ")}`
        );
    } else {
        if (permissions.allowTools && permissions.allowTools.length > 0) {
            lines.push(`Additional tools enabled: ${permissions.allowTools.join(", ")}`);
        }
        if (permissions.denyTools && permissions.denyTools.length > 0) {
            lines.push(`Tools disabled: ${permissions.denyTools.join(", ")}`);
        }
    }

    if (lines.length === 0) {
        return "";
    }

    return `<skill-tool-permissions>
<!-- Aggregated across all active skills -->
${lines.join("\n")}
</skill-tool-permissions>`;
}

/**
 * Replace known path prefixes with their env variable names.
 * Longest prefix wins so $AGENT_HOME/skills beats $USER_HOME/...
 */
function compressPath(absolutePath: string, pathVars?: Record<string, string>): string {
    if (!pathVars) return absolutePath;
    let best = absolutePath;
    let bestLen = 0;
    for (const [varName, varValue] of Object.entries(pathVars)) {
        if (absolutePath.startsWith(varValue) && varValue.length > bestLen) {
            best = varName + absolutePath.slice(varValue.length);
            bestLen = varValue.length;
        }
    }
    return best;
}

export function renderSkill(skill: SkillData, pathVars?: Record<string, string>): string {
    const attrs: string[] = [];
    attrs.push(`id="${escapeAttrValue(skill.identifier)}"`);
    if (skill.localDir && skill.scope !== "built-in") {
        attrs.push(`path="${escapeAttrValue(compressPath(skill.localDir, pathVars))}"`);
    }

    const attrStr = ` ${attrs.join(" ")}`;

    const failedFiles = skill.installedFiles.filter((f) => !f.success);

    // Self-closing tag for skills with no content and no load diagnostics.
    if ((!skill.content || skill.content.trim() === "") && failedFiles.length === 0) {
        return `<skill${attrStr} />`;
    }

    const parts: string[] = [];
    parts.push(`<skill${attrStr}>`);
    if (skill.content && skill.content.trim() !== "") {
        parts.push(skill.content);
    }

    if (failedFiles.length > 0) {
        parts.push("");
        parts.push("## Failed File Downloads");
        for (const file of failedFiles) {
            parts.push(`- ${file.relativePath}: ${file.error}`);
        }
    }

    parts.push("</skill>");

    return parts.join("\n");
}

/**
 * Render the full `<loaded-skills>` block for the system reminder.
 * Returns null if there are no skills.
 */
export function renderLoadedSkillsBlock(
    skills: SkillData[],
    permissions?: SkillToolPermissions,
    pathVars?: Record<string, string>
): string | null {
    if (skills.length === 0) {
        return null;
    }

    const parts: string[] = [];

    if (permissions) {
        const permissionsHeader = renderToolPermissionsHeader(permissions);
        if (permissionsHeader) {
            parts.push(permissionsHeader);
        }
    }

    const header = `
The following skills have been loaded for this conversation. These provide additional context and capabilities:
`;
    const renderedSkills = skills.map((skill) => renderSkill(skill, pathVars));
    parts.push(header + renderedSkills.join("\n\n"));

    return parts.join("\n\n");
}
