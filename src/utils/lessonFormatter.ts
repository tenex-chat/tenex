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

        // Build metadata line
        let metadata = "";
        if (category) metadata += ` [${category}]`;
        if (hasDetailed) metadata += " [detailed available]";
        if (hashtags && hashtags.length > 0) metadata += ` #${hashtags.join(" #")}`;

        // Create a concise format for each lesson
        return `#${index + 1}: ${title} ${metadata}\n${content}${hasDetailed ? `\n↳ Use lesson_get("${title}") for detailed version` : ""}`;
    })
    .join("\n\n");

  // Add header for context
  const header = `## Lessons Learned (${lessons.length} total)\n\n`;

  return header + formattedLessons;
}
