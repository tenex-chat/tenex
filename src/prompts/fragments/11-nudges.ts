import type { PromptFragment } from "../core/types";

interface NudgesArgs {
    nudgeContent: string;
}

/**
 * Fragment for injecting nudge content into the system prompt.
 * Nudges are kind:4201 events referenced via nudge tags on the triggering event.
 * Their content is fetched and injected to provide additional context/instructions.
 */
export const nudgesFragment: PromptFragment<NudgesArgs> = {
    id: "nudges",
    priority: 11, // After referenced-article (10), before available-agents (15)
    template: ({ nudgeContent }) => {
        if (!nudgeContent || nudgeContent.trim().length === 0) {
            return "";
        }

        return `<nudges>
${nudgeContent}
</nudges>`;
    },
    validateArgs: (args: unknown): args is NudgesArgs => {
        if (typeof args !== "object" || args === null) return false;
        const a = args as Record<string, unknown>;
        return typeof a.nudgeContent === "string";
    },
    expectedArgs: "{ nudgeContent: string }",
};
