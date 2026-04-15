import type { PromptFragment } from "../core/types";

/**
 * Explains reminder tags that agents encounter in tool results, user messages,
 * and request-time system reminder blocks.
 * Always included — agents need this context before encountering any actual reminders.
 */
export const systemRemindersExplanationFragment: PromptFragment<Record<string, never>> = {
    id: "system-reminders-explanation",
    priority: 3,
    template: () => {
        return `<system-reminders-explanation>
System messages may include \`<system-reminders>\` blocks, and tool results or user messages may include \`<system-reminder>\` tags. These are system-injected informational context — not user speech. They contain dynamic information such as behavioral guidance, context updates, and state notifications. They bear no direct relation to the surrounding message unless the reminder content says otherwise.

System reminders are background context for you to absorb silently. Do not acknowledge, reference, or respond to them as if the user said something. Incorporate relevant information into your behavior naturally, but never surface the reminder itself in your response.
</system-reminders-explanation>`;
    },
};
