/**
 * Rendering functions for skill-related system reminders.
 *
 * Extracted from the former prompt fragments `12-skills` and `13-available-skills`.
 * Lives at Layer 3 (agents/) so it can legitimately import from services/skill.
 */

import type { SkillData, SkillStoreScope, SkillToolPermissions, WhitelistItem } from "@/services/skill";
import { hasToolPermissions, isOnlyToolMode, SkillWhitelistService } from "@/services/skill";
import { SkillService } from "@/services/skill/SkillService";
import { buildExpandedBlockedSet, isSkillBlocked } from "@/services/skill/skill-blocking";

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
    const parts: string[] = [];

    const attrs: string[] = [];
    attrs.push(`id="${escapeAttrValue(skill.identifier)}"`);
    if (skill.localDir && skill.scope !== "built-in") {
        attrs.push(`path="${escapeAttrValue(compressPath(skill.localDir, pathVars))}"`);
    }

    const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";

    parts.push(`<skill${attrStr}>`);

    parts.push(skill.content);

    const failedFiles = skill.installedFiles.filter((f) => !f.success);
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

// ---------------------------------------------------------------------------
// Available-skills rendering (from former 13-available-skills.ts)
// ---------------------------------------------------------------------------

function escapePromptText(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

const MAX_DESCRIPTION_LENGTH = 150;

function summarizeContent(value?: string): string {
    if (!value) {
        return "No description";
    }

    return value.replace(/\n/g, " ").substring(0, MAX_DESCRIPTION_LENGTH);
}

function formatWhitelistItem(item: WhitelistItem): string {
    const identifier = item.identifier ?? item.shortId ?? item.eventId;
    return `- \`${escapePromptText(identifier)}\`: ${escapePromptText(summarizeContent(item.description))}`;
}

function formatSkillItem(skill: SkillData): string {
    const identifier = skill.identifier;
    const desc = escapePromptText(summarizeContent(skill.description ?? skill.content));
    return `- \`${escapePromptText(identifier)}\`: ${desc}`;
}

type ScopeGroup = "your-project" | "your-all" | "project" | "shared" | "built-in";

function classifyScope(scope: SkillStoreScope): ScopeGroup {
    switch (scope) {
        case "agent-project": return "your-project";
        case "agent": return "your-all";
        case "project": return "project";
        case "shared": return "shared";
        case "built-in": return "built-in";
    }
}

/**
 * Render the inner content for the `available-skills` system reminder.
 * The outer `<available-skills>` tag is added by the reminder combiner.
 */
export async function renderAvailableSkillsBlock(
    agentPubkey: string,
    projectPath?: string,
    blockedSkills?: string[]
): Promise<string> {
    const whitelistService = SkillWhitelistService.getInstance();
    const whitelistedItems = whitelistService.getWhitelistedSkills();
    const installedSkills = await SkillService.getInstance().listAvailableSkills({
        agentPubkey,
        projectPath,
    });
    const blockedSet = buildExpandedBlockedSet(blockedSkills);
    const filteredInstalledSkills = installedSkills.filter((skill) => {
        if (isSkillBlocked(skill.identifier, blockedSet)) return false;
        if (skill.eventId && isSkillBlocked(skill.eventId, blockedSet)) return false;
        return true;
    });
    const filteredWhitelistedItems = whitelistedItems.filter((item) => {
        const candidateId = item.identifier ?? item.shortId ?? item.eventId;
        return candidateId ? !isSkillBlocked(candidateId, blockedSet) : true;
    });

    const installedEventIds = new Set<string>();
    for (const skill of filteredInstalledSkills) {
        if (skill.eventId) {
            installedEventIds.add(skill.eventId);
        }
    }

    // Group installed skills by scope group
    const grouped = new Map<ScopeGroup, string[]>();

    for (const skill of filteredInstalledSkills) {
        const group = classifyScope(skill.scope ?? "shared");
        if (!grouped.has(group)) {
            grouped.set(group, []);
        }
        const groupItems = grouped.get(group);
        if (groupItems) {
            groupItems.push(formatSkillItem(skill));
        }
    }

    // Unhydrated whitelisted items go under "shared"
    const unhydratedWhitelisted = filteredWhitelistedItems.filter(
        item => !installedEventIds.has(item.eventId)
    );
    if (unhydratedWhitelisted.length > 0) {
        if (!grouped.has("shared")) {
            grouped.set("shared", []);
        }
        for (const item of unhydratedWhitelisted) {
            const sharedItems = grouped.get("shared");
            if (sharedItems) {
                sharedItems.push(formatWhitelistItem(item));
            }
        }
    }

    const parts: string[] = ["Use the IDs exactly as shown below.", ""];

    // Your skills (agent-scoped) — always show structure
    parts.push("<your-skills>");
    parts.push("These are skills only available to you:");
    parts.push("");
    parts.push("### On this project (`$PROJECT_BASE/.agents/<your-short-pubkey>/skills`)");
    const yourProject = grouped.get("your-project") ?? [];
    if (yourProject.length > 0) {
        parts.push(...yourProject);
    } else {
        parts.push("(none)");
    }
    parts.push("");
    parts.push("### All projects (`$AGENT_HOME/skills`)");
    const yourAll = grouped.get("your-all") ?? [];
    if (yourAll.length > 0) {
        parts.push(...yourAll);
    } else {
        parts.push("(none)");
    }
    parts.push("</your-skills>");
    parts.push("");

    // Project skills — always show
    parts.push("<project-skills>");
    parts.push("These are skills available for this project, shared with all your teammates (`$PROJECT_BASE/.agents/skills`):");
    parts.push("");
    const projectSkills = grouped.get("project") ?? [];
    if (projectSkills.length > 0) {
        parts.push(...projectSkills);
    } else {
        parts.push("(none)");
    }
    parts.push("</project-skills>");
    parts.push("");

    // Global/shared skills — always show
    parts.push("<global-skills>");
    parts.push("Skills in `~/.agents/skills`:");
    parts.push("");
    const sharedSkills = grouped.get("shared") ?? [];
    if (sharedSkills.length > 0) {
        parts.push(...sharedSkills);
    } else {
        parts.push("(none)");
    }
    parts.push("</global-skills>");
    parts.push("");

    // Built-in skills — always show
    parts.push("<built-in>");
    parts.push("These are built-in skills you can activate at any point using skills_set:");
    parts.push("");
    const builtIn = grouped.get("built-in") ?? [];
    if (builtIn.length > 0) {
        parts.push(...builtIn);
    } else {
        parts.push("(none)");
    }
    parts.push("</built-in>");

    return parts.join("\n");
}
