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

    // Sort by creation time (newest first)
    const sortedLessons = lessons.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

    // Take up to 50 lessons (should already be limited by ProjectContext)
    const limitedLessons = sortedLessons.slice(0, 50);

    // Format each lesson concisely
    const formattedLessons = limitedLessons.map((lesson, index) => {
        const title = lesson.title || "Untitled Lesson";
        const content = lesson.lesson || lesson.content || "";
        const phase = lesson.tags.find((tag) => tag[0] === "phase")?.[1];
        const quality = lesson.quality || "unknown";

        // Create a concise format for each lesson
        return `#${index + 1}: ${title}${phase ? ` (${phase})` : ""} [${quality}]\n${content}`;
    }).join("\n\n");

    // Add header for context
    const header = `## Lessons Learned (${limitedLessons.length} most recent)\n\n`;

    return header + formattedLessons;
}