import type { WhitelistItem } from "@/services/nudge";
import type { PromptFragment } from "../core/types";

/**
 * Combined fragment for displaying available nudges AND skills to agents.
 *
 * Renders under a single "Available Nudges and Skills" heading so agents
 * recognise this section when asked about either nudges or skills.
 *
 * - Shows subsection headers (### Nudges / ### Skills) when BOTH types are present.
 * - Omits the subsection header when only one type exists.
 * - Returns empty string when neither nudges nor skills are available.
 */
interface AvailableNudgesAndSkillsArgs {
    /** Whitelisted nudges from the NudgeWhitelistService */
    availableNudges?: WhitelistItem[];
    /** Whitelisted skills from the NudgeSkillWhitelistService */
    availableSkills?: WhitelistItem[];
}

/**
 * Escape text for safe inclusion in prompt output.
 * Prevents injection attacks by escaping special characters.
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

/**
 * Format a single WhitelistItem into a markdown bullet line.
 */
function formatItem(item: WhitelistItem): string {
    const name = item.name || item.eventId.substring(0, 12);
    const description = item.description
        ? item.description.replace(/\n/g, " ").substring(0, MAX_DESCRIPTION_LENGTH)
        : "No description";
    return `  - **${escapePromptText(name)}** (${item.eventId.substring(0, 12)}): ${escapePromptText(description)}`;
}

export const availableNudgesAndSkillsFragment: PromptFragment<AvailableNudgesAndSkillsArgs> = {
    id: "available-nudges-and-skills",
    priority: 13, // Before available-agents (15)
    template: ({ availableNudges, availableSkills }) => {
        const nudges = availableNudges ?? [];
        const skills = availableSkills ?? [];
        const hasNudges = nudges.length > 0;
        const hasSkills = skills.length > 0;

        if (!hasNudges && !hasSkills) {
            return "";
        }

        const hasBoth = hasNudges && hasSkills;
        const sections: string[] = [];

        // --- Header ---
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

        // --- Nudges ---
        if (hasNudges) {
            sections.push("");
            if (hasBoth) {
                sections.push("### Nudges");
                sections.push("");
            }
            sections.push(nudges.map(formatItem).join("\n"));
        }

        // --- Skills ---
        if (hasSkills) {
            sections.push("");
            if (hasBoth) {
                sections.push("### Skills");
                sections.push("");
            }
            sections.push(skills.map(formatItem).join("\n"));
        }

        // --- Example ---
        const exampleId =
            (hasNudges ? nudges[0] : skills[0]).eventId.substring(0, 12);
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
    validateArgs: (args: unknown): args is AvailableNudgesAndSkillsArgs => {
        if (typeof args !== "object" || args === null) return false;
        const a = args as Record<string, unknown>;
        if (a.availableNudges !== undefined && !Array.isArray(a.availableNudges)) return false;
        if (a.availableSkills !== undefined && !Array.isArray(a.availableSkills)) return false;
        return true;
    },
    expectedArgs: "{ availableNudges?: WhitelistItem[], availableSkills?: WhitelistItem[] }",
};
