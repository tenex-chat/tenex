import type { NDKAgentLesson } from "@/events/NDKAgentLesson";

/**
 * Standard output shape for lesson retrieval operations.
 * Consolidates the lesson data structure to avoid duplication between lesson_get and lessons_list.
 */
export type FormattedLessonOutput = {
    eventId: string;
    title: string;
    lesson: string;
    detailed?: string;
    category?: string;
    hashtags?: string[];
    hasDetailed: boolean;
};

/**
 * Formats a lesson into the standard output shape.
 * Used by both lesson_get and lessons_list to ensure consistent formatting.
 *
 * @param lesson - The NDKAgentLesson to format
 * @param eventId - The event ID (may differ from lesson.id if normalized)
 * @returns Formatted lesson output
 */
export function formatLessonOutput(
    lesson: NDKAgentLesson,
    eventId: string
): FormattedLessonOutput {
    return {
        eventId,
        title: lesson.title || "Untitled",
        lesson: lesson.lesson || lesson.content,
        detailed: lesson.detailed,
        category: lesson.category,
        hashtags: lesson.hashtags,
        hasDetailed: !!lesson.detailed,
    };
}
