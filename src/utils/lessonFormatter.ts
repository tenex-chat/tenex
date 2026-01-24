import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { logger } from "@/utils/logger";

/**
 * Format agent lessons into a concise string without using LLM
 * This is a simple concatenation with minimal formatting
 */
export function formatLessonsForAgent(lessons: NDKAgentLesson[]): string {
    if (lessons.length === 0) {
        return "";
    }

    logger.debug("Formatting lessons for agent", {
        lessonsCount: lessons.length,
    });

    // Format each lesson concisely - ALL OF THEM!
    const formattedLessons = lessons
        .map((lesson, index) => {
            const title = lesson.title || "Untitled Lesson";
            const content = lesson.lesson;
            const category = lesson.category;
            const hashtags = lesson.hashtags;
            const hasDetailed = !!lesson.detailed;
            // Get 12-char prefix for convenient lookup (lesson_get accepts prefixes)
            const idPrefix = lesson.id ? lesson.id.substring(0, 12) : null;

            // Build metadata line
            let metadata = "";
            if (category) metadata += ` [${category}]`;
            if (hasDetailed) metadata += " [detailed available]";
            if (hashtags && hashtags.length > 0) metadata += ` #${hashtags.join(" #")}`;

            // Create a concise format for each lesson
            // Show ID prefix for lesson_get if detailed version available
            const detailedHint = hasDetailed && idPrefix
                ? `\n↳ Use lesson_get("${idPrefix}") for detailed version`
                : "";
            return `#${index + 1}: ${title} ${metadata}\n${content}${detailedHint}`;
        })
        .join("\n\n");

    // Add header for context
    const header = `## Lessons Learned (${lessons.length} total)\n\n`;

    return header + formattedLessons;
}

/**
 * The standard lesson_learn tool reminder to encourage agents to continue learning.
 */
export const LESSON_LEARN_REMINDER =
    "Remember to use the `lesson_learn` tool when you discover new insights or patterns.";

/**
 * Format lessons for inclusion in a system prompt.
 * Includes the formatted lessons + the lesson_learn tool reminder.
 * This is the single source of truth for lesson prompt formatting.
 *
 * @param lessons The agent's lessons
 * @returns Formatted lessons with reminder, or empty string if no lessons
 */
export function formatLessonsWithReminder(lessons: NDKAgentLesson[]): string {
    if (lessons.length === 0) {
        return "";
    }

    const formattedLessons = formatLessonsForAgent(lessons);
    return `${formattedLessons}\n\n${LESSON_LEARN_REMINDER}`;
}
