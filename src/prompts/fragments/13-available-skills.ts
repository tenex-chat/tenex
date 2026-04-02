import { SkillWhitelistService } from "@/services/skill";
import type { WhitelistItem } from "@/services/skill";
import { SkillService } from "@/services/skill/SkillService";
import type { SkillData, SkillStoreScope } from "@/services/skill";
import type { PromptFragment } from "../core/types";

interface AvailableSkillsArgs {
    agentPubkey: string;
    projectPath?: string;
}

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

export const availableSkillsFragment: PromptFragment<AvailableSkillsArgs> = {
    id: "available-skills",
    priority: 13,
    template: async ({ agentPubkey, projectPath }) => {
        const whitelistService = SkillWhitelistService.getInstance();
        const whitelistedItems = whitelistService.getWhitelistedSkills();
        const installedSkills = await SkillService.getInstance().listAvailableSkills({
            agentPubkey,
            projectPath,
        });

        const installedEventIds = new Set(
            installedSkills.filter(s => s.eventId).map(s => s.eventId!)
        );

        // Group installed skills by scope group
        const grouped = new Map<ScopeGroup, string[]>();

        for (const skill of installedSkills) {
            const group = classifyScope(skill.scope ?? "shared");
            if (!grouped.has(group)) {
                grouped.set(group, []);
            }
            grouped.get(group)!.push(formatSkillItem(skill));
        }

        // Unhydrated whitelisted items go under "shared"
        const unhydratedWhitelisted = whitelistedItems.filter(
            item => !installedEventIds.has(item.eventId)
        );
        if (unhydratedWhitelisted.length > 0) {
            if (!grouped.has("shared")) {
                grouped.set("shared", []);
            }
            for (const item of unhydratedWhitelisted) {
                grouped.get("shared")!.push(formatWhitelistItem(item));
            }
        }

        const parts: string[] = ["<available-skills>", "Use the IDs exactly as shown below.", ""];

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
        const builtIn = grouped.get("built-in") ?? [];
        if (builtIn.length > 0) {
            parts.push(...builtIn);
        } else {
            parts.push("(none)");
        }
        parts.push("</built-in>");

        parts.push("</available-skills>");
        return parts.join("\n");
    },
};
