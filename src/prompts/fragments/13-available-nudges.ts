import { NudgeSkillWhitelistService } from "@/services/nudge";
import type { WhitelistItem } from "@/services/nudge";
import { SkillService } from "@/services/skill/SkillService";
import type { SkillData } from "@/services/skill";
import type { PromptFragment } from "../core/types";

interface AvailableNudgesAndSkillsArgs {
    agentPubkey: string;
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

function formatNudgeItem(item: WhitelistItem): string {
    const identifier = item.identifier ?? item.shortId ?? item.eventId;
    return `  - \`${escapePromptText(identifier)}\`: ${escapePromptText(summarizeContent(item.description))}`;
}

function formatSkillItem(skill: SkillData): string {
    const identifier = skill.identifier;
    return `  - \`${escapePromptText(identifier)}\`: ${escapePromptText(summarizeContent(skill.description ?? skill.content))}`;
}

export const availableNudgesAndSkillsFragment: PromptFragment<AvailableNudgesAndSkillsArgs> = {
    id: "available-nudges-and-skills",
    priority: 13,
    template: async ({ agentPubkey, projectDTag }) => {
        const whitelistService = NudgeSkillWhitelistService.getInstance();
        const nudges = whitelistService.getWhitelistedNudges();
        const skills = await SkillService.getInstance().listAvailableSkills({
            agentPubkey,
            projectDTag,
        });
        const hasNudges = nudges.length > 0;
        const hasSkills = skills.length > 0;

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
            sections.push(nudges.map(formatNudgeItem).join("\n"));
        }

        if (hasSkills) {
            sections.push("");
            if (hasBoth) {
                sections.push("### Skills");
                sections.push("");
            }
            sections.push(skills.map(formatSkillItem).join("\n"));
        }

        return sections.join("\n");
    },
};
