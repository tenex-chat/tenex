/**
 * SystemReminderUtils - Utilities for wrapping and managing system reminder content
 *
 * This module provides shared utilities for creating consistent `<system-reminder>` XML tags
 * that are used for behavioral nudges and context injections.
 *
 * The `<system-reminder>` format is used for:
 * - Heuristic violations (todo nudge, delegation warnings, etc.)
 * - Deferred injections (supervision messages for next turn)
 * - Dynamic context (response context, todo state)
 *
 * NOT used for (these stay tool-bound):
 * - AGENTS.md injections (remain in tool result output)
 * - Pre-tool supervision blocks (remain in tool result)
 */

/**
 * Wrap content in `<system-reminder>` tags.
 *
 * @param content - The content to wrap (can be multi-line)
 * @returns Content wrapped in system-reminder tags
 */
export function wrapInSystemReminder(content: string): string {
    if (!content || content.trim() === "") {
        return "";
    }
    return `<system-reminder>\n${content.trim()}\n</system-reminder>`;
}

/**
 * Combine multiple system reminder contents into a single wrapped block.
 *
 * @param contents - Array of content strings to combine
 * @returns Single system-reminder block with all contents, or empty string if no content
 */
export function combineSystemReminders(contents: string[]): string {
    const nonEmpty = contents.filter((c) => c && c.trim() !== "");
    if (nonEmpty.length === 0) {
        return "";
    }
    return wrapInSystemReminder(nonEmpty.join("\n\n"));
}

/**
 * Append system reminder content to an existing message.
 *
 * NOTE: This is a simple utility that appends the reminder to the end of the
 * existing content with double newline separation. It does NOT merge with
 * existing system-reminder blocks. For that use case, use MessageCompiler's
 * appendEphemeralMessagesToLastUserMessage method which handles extraction
 * and recombination.
 *
 * @param existingContent - The existing message content
 * @param reminderContent - The system reminder content to append (already wrapped or raw)
 * @returns The combined content with reminder appended
 */
export function appendSystemReminderToMessage(
    existingContent: string,
    reminderContent: string
): string {
    if (!reminderContent || reminderContent.trim() === "") {
        return existingContent;
    }

    // If reminderContent is not already wrapped, wrap it
    const wrappedReminder = reminderContent.trim().startsWith("<system-reminder>")
        ? reminderContent
        : wrapInSystemReminder(reminderContent);

    return `${existingContent}\n\n${wrappedReminder}`;
}

/**
 * Check if a string contains system-reminder tags.
 *
 * @param content - The content to check
 * @returns True if content contains system-reminder tags
 */
export function hasSystemReminder(content: string): boolean {
    return content.includes("<system-reminder>") && content.includes("</system-reminder>");
}

/**
 * Extract the content from within the first system-reminder tag block.
 * Returns empty string if no valid system-reminder block found.
 *
 * NOTE: This only extracts the first block. For extracting all blocks,
 * use MessageCompiler's extractAllSystemReminderContents method.
 *
 * @param content - The content potentially containing system-reminder tags
 * @returns The content inside the first tags, or empty string
 */
export function extractSystemReminderContent(content: string): string {
    const match = content.match(/<system-reminder>\n?([\s\S]*?)\n?<\/system-reminder>/);
    return match ? match[1].trim() : "";
}
