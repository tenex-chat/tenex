import type { PromptFragment } from "../core/types";

/**
 * Explains <system-reminder> tags that agents encounter in tool results and user messages.
 * Always included — agents need this context before encountering any actual reminders.
 */
export const systemRemindersExplanationFragment: PromptFragment<Record<string, never>> = {
    id: "system-reminders-explanation",
    priority: 3,
    template: () => {
        return `## System Reminders
Tool results and user messages may include \`<system-reminder>\` tags. These contain dynamic information from the system — behavioral guidance, context updates, and state notifications. They bear no direct relation to the specific tool results or user messages in which they appear. Follow the instructions within them.`;
    },
};
