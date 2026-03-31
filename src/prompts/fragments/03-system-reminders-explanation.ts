import type { PromptFragment } from "../core/types";

/**
 * Explains <system-reminder> tags that agents encounter in tool results and user messages.
 * Always included — agents need this context before encountering any actual reminders.
 */
export const systemRemindersExplanationFragment: PromptFragment<Record<string, never>> = {
    id: "system-reminders-explanation",
    priority: 3,
    template: () => {
        return `<system-reminders-explanation>
Tool results and user messages may include typed \`<system-reminder type="...">\` tags. These contain dynamic information from the system such as behavioral guidance, context updates, and state notifications. The \`type\` attribute tells you what kind of reminder you are reading. These reminders bear no direct relation to the specific tool results or user messages in which they appear unless the reminder content says otherwise. Follow the instructions within them.
</system-reminders-explanation>`;
    },
};
