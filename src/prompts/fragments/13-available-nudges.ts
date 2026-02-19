import type { WhitelistItem } from "@/services/nudge";
import type { PromptFragment } from "../core/types";

/**
 * Fragment for displaying available nudges to agents.
 *
 * This shows agents which nudges are available for use in delegations.
 * Nudges can modify tool availability and inject additional context.
 */
interface AvailableNudgesArgs {
    /** Whitelisted nudges from the NudgeWhitelistService */
    availableNudges: WhitelistItem[];
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

/** Maximum description length for display in available nudges list */
const MAX_DESCRIPTION_LENGTH = 150;

export const availableNudgesFragment: PromptFragment<AvailableNudgesArgs> = {
    id: "available-nudges",
    priority: 13, // After nudges (11), skills (12), before available-agents (15)
    template: ({ availableNudges }) => {
        if (!availableNudges || availableNudges.length === 0) {
            return "";
        }

        const nudgeList = availableNudges
            .map((nudge) => {
                const name = nudge.name || nudge.eventId.substring(0, 12);
                // Truncate description here in presentation layer (service keeps full content)
                const description = nudge.description
                    ? nudge.description.replace(/\n/g, " ").substring(0, MAX_DESCRIPTION_LENGTH)
                    : "No description";
                return `  - **${escapePromptText(name)}** (${nudge.eventId.substring(0, 12)}): ${escapePromptText(description)}`;
            })
            .join("\n");

        return `## Available Nudges

The following nudges are available for use when delegating tasks. Pass nudge event IDs in the \`nudges\` parameter of the delegate tool to apply them to delegated agents.

Nudges can modify tool availability (only-tool, allow-tool, deny-tool) and inject additional context/instructions into the agent's system prompt.

${nudgeList}

Example usage:
\`\`\`
delegate({
  delegations: [{
    recipient: "agent-slug",
    prompt: "Your task here",
    nudges: ["${availableNudges[0]?.eventId.substring(0, 12)}..."]
  }]
})
\`\`\``;
    },
    validateArgs: (args: unknown): args is AvailableNudgesArgs => {
        if (typeof args !== "object" || args === null) return false;
        const a = args as Record<string, unknown>;
        if (a.availableNudges === undefined) return true; // Optional
        if (!Array.isArray(a.availableNudges)) return false;
        return true;
    },
    expectedArgs: "{ availableNudges?: WhitelistItem[] }",
};
