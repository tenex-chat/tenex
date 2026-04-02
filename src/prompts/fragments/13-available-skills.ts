import { SkillWhitelistService } from "@/services/skill";
import type { WhitelistItem } from "@/services/skill";
import { SkillService } from "@/services/skill/SkillService";
import type { SkillData } from "@/services/skill";
import { NDKKind } from "@/nostr/kinds";
import type { PromptFragment } from "../core/types";

interface AvailableSkillsArgs {
    agentPubkey: string;
    projectPath?: string;
    projectDTag?: string;
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
    const unlocks = skill.toolNames && skill.toolNames.length > 0
        ? ` | Unlocks: ${skill.toolNames.map((t) => `\`${t}\``).join(", ")}`
        : "";
    return `  - \`${escapePromptText(identifier)}\`: ${desc}${unlocks}`;
}

export const availableSkillsFragment: PromptFragment<AvailableSkillsArgs> = {
    id: "available-skills",
    priority: 13,
    template: async ({ agentPubkey, projectPath, projectDTag }) => {
        const whitelistService = SkillWhitelistService.getInstance();
        const whitelistedItems = whitelistService.getWhitelistedSkills();
        const installedSkills = await SkillService.getInstance().listAvailableSkills({
            agentPubkey,
            projectPath,
            projectDTag,
        });

        // Partition whitelisted items: kind:4201 shown as "Nudges", kind:4202 as "Skills"
        const nudgeItems = whitelistedItems.filter((item) => item.kind === NDKKind.AgentNudge);
        const skillItems = whitelistedItems.filter((item) => item.kind === NDKKind.AgentSkill);

        const nudgeLines = nudgeItems.map(formatWhitelistItem);
        const skillLines = [
            ...skillItems.map(formatWhitelistItem),
            ...installedSkills.map(formatSkillItem),
        ];

        const hasNudges = nudgeLines.length > 0;
        const hasSkills = skillLines.length > 0;

        if (!hasNudges && !hasSkills) {
            return "";
        }

        const hasBoth = hasNudges && hasSkills;
        const sections: string[] = [];

        sections.push("## Available Nudges and Skills");
        sections.push("");
        sections.push("Use the IDs exactly as shown below.");

        if (hasNudges) {
            sections.push("");
            if (hasBoth) {
                sections.push("### Nudges");
                sections.push("");
            }
            sections.push(nudgeLines.join("\n"));
        }

        if (hasSkills) {
            sections.push("");
            if (hasBoth) {
                sections.push("### Skills");
                sections.push("");
            }
            sections.push(skillLines.join("\n"));
        }

        return sections.join("\n");
    },
};
