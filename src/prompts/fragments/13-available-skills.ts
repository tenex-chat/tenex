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
    return `  - \`${escapePromptText(identifier)}\`: ${escapePromptText(summarizeContent(item.description))}`;
}

function formatSkillItem(skill: SkillData): string {
    const identifier = skill.identifier;
    const desc = escapePromptText(summarizeContent(skill.description ?? skill.content));
    return `  - \`${escapePromptText(identifier)}\`: ${desc}`;
}

const SCOPE_GROUP_TAG: Record<SkillStoreScope, string> = {
    "built-in": "built-in",
    "agent": `path "$AGENT_HOME/skills"`,
    "agent-project": `path "$PROJECT_BASE/.agents/<agent-short-pubkey>/skills"`,
    "project": `path "$PROJECT_BASE/.agents/skills"`,
    "shared": `path "$USER_HOME/.agents/skills"`,
};

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

        if (installedSkills.length === 0 && whitelistedItems.length === 0) {
            return "";
        }

        // Group installed skills by scope
        const installedEventIds = new Set(
            installedSkills.filter(s => s.eventId).map(s => s.eventId!)
        );

        const groupedLines = new Map<string, string[]>();

        for (const skill of installedSkills) {
            const tag = SCOPE_GROUP_TAG[skill.scope ?? "shared"];
            if (!groupedLines.has(tag)) {
                groupedLines.set(tag, []);
            }
            groupedLines.get(tag)!.push(formatSkillItem(skill));
        }

        // Whitelisted items not yet hydrated go under "global"
        const unhydratedWhitelisted = whitelistedItems.filter(
            item => !installedEventIds.has(item.eventId)
        );
        if (unhydratedWhitelisted.length > 0) {
            const sharedTag = SCOPE_GROUP_TAG.shared;
            if (!groupedLines.has(sharedTag)) {
                groupedLines.set(sharedTag, []);
            }
            for (const item of unhydratedWhitelisted) {
                groupedLines.get(sharedTag)!.push(formatWhitelistItem(item));
            }
        }

        const parts: string[] = ["<available-skills>"];
        parts.push("Use the IDs exactly as shown below.");
        parts.push("");

        for (const [tag, lines] of groupedLines) {
            parts.push(`  <${tag}>`);
            parts.push(...lines);
            parts.push(`  </${tag.split(" ")[0]}>`);
        }

        parts.push("</available-skills>");
        return parts.join("\n");
    },
};
