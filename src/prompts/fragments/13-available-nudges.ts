import { NudgeSkillWhitelistService } from "@/services/nudge";
import type { WhitelistItem } from "@/services/nudge";
import type { PromptFragment } from "../core/types";

/**
 * Escape text for safe inclusion in prompt output.
 */
function escapePromptText(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/** Maximum description length for display in list items */
const MAX_DESCRIPTION_LENGTH = 150;

function formatItem(item: WhitelistItem): string {
    const name = item.name || item.eventId.substring(0, 12);
    const description = item.description
        ? item.description.replace(/\n/g, " ").substring(0, MAX_DESCRIPTION_LENGTH)
        : "No description";
    return `  - **${escapePromptText(name)}** (${item.eventId.substring(0, 12)}): ${escapePromptText(description)}`;
}

/**
 * Fragment for displaying available nudges and skills to agents.
 * Reads directly from NudgeSkillWhitelistService — no args needed.
 *
 * - Shows subsection headers (### Nudges / ### Skills) when BOTH types are present.
 * - Omits the subsection header when only one type exists.
 * - Returns empty string when neither nudges nor skills are available.
 */
export const availableNudgesAndSkillsFragment: PromptFragment<Record<string, never>> = {
    id: "available-nudges-and-skills",
    priority: 13, // Before available-agents (15)
    template: () => {
        const service = NudgeSkillWhitelistService.getInstance();
        const nudges = service.getWhitelistedNudges();
        const skills = service.getWhitelistedSkills();
        const hasNudges = nudges.length > 0;
        const hasSkills = skills.length > 0;

        if (!hasNudges && !hasSkills) {
            return "";
        }

        const hasBoth = hasNudges && hasSkills;
        const sections: string[] = [];

        sections.push("## Available Nudges and Skills");
        sections.push("");
        sections.push(
            "The following nudges and skills are available for use when delegating tasks. Pass their event IDs in the `nudges` parameter of the delegate tool to apply them to delegated agents."
        );
        sections.push("");
        sections.push(
            "Nudges can modify tool availability (only-tool, allow-tool, deny-tool) and inject additional context/instructions into the agent's system prompt."
        );
        sections.push(
            "Skills provide transient capabilities and context without modifying tool availability."
        );

        if (hasNudges) {
            sections.push("");
            if (hasBoth) {
                sections.push("### Nudges");
                sections.push("");
            }
            sections.push(nudges.map(formatItem).join("\n"));
        }

        if (hasSkills) {
            sections.push("");
            if (hasBoth) {
                sections.push("### Skills");
                sections.push("");
            }
            sections.push(skills.map(formatItem).join("\n"));
        }

        const exampleId = (hasNudges ? nudges[0] : skills[0]).eventId.substring(0, 12);
        sections.push("");
        sections.push("Example usage:");
        sections.push("```");
        sections.push("delegate({");
        sections.push("  delegations: [{");
        sections.push('    recipient: "agent-slug",');
        sections.push('    prompt: "Your task here",');
        sections.push(`    nudges: ["${exampleId}..."]`);
        sections.push("  }]");
        sections.push("})");
        sections.push("```");

        return sections.join("\n");
    },
};
