import { getProjectContext } from "@/services/ProjectContext";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema, success, failure } from "../types";

const lessonGetSchema = z.object({
  title: z.string().describe("Title of the lesson to retrieve"),
});

interface LessonGetInput {
  title: string;
}

interface LessonGetOutput {
  title: string;
  lesson: string;
  detailed?: string;
  category?: string;
  hashtags?: string[];
  hasDetailed: boolean;
}

export const lessonGetTool: Tool<LessonGetInput, LessonGetOutput> = {
  name: "lesson_get",
  description:
    "Retrieve the full version of a lesson by its title, including detailed explanation if available",

  promptFragment: `Use the lesson_get tool when you need to retrieve the full details of a lesson you've learned before. This is especially useful when:
- You need more context about a previously learned lesson
- The lesson summary mentions a detailed version is available
- You're working on something related to a past lesson and need the full context

The tool will return both the summary and detailed version (if available) of the lesson.`,

  parameters: createZodSchema(lessonGetSchema),

  execute: async (input, context) => {
    const { title } = input.value;

    logger.info("📖 Agent retrieving lesson by title", {
      agent: context.agent.name,
      agentPubkey: context.agent.pubkey,
      title,
      phase: context.phase,
      conversationId: context.conversationId,
    });

    try {
      // Get the project context to access in-memory lessons
      const projectContext = getProjectContext();
      
      // Get lessons for this agent from memory
      const agentLessons = projectContext.getLessonsForAgent(context.agent.pubkey);
      
      // Search for a lesson matching the title (case-insensitive)
      const normalizedSearchTitle = title.toLowerCase().trim();
      const matchingLesson = agentLessons.find(lesson => {
        const lessonTitle = (lesson.title || "").toLowerCase().trim();
        return lessonTitle === normalizedSearchTitle;
      });

      // Determine which lesson to use (exact match or partial)
      const lesson = matchingLesson || agentLessons.find(lesson => {
        const lessonTitle = (lesson.title || "").toLowerCase().trim();
        return lessonTitle.includes(normalizedSearchTitle) || normalizedSearchTitle.includes(lessonTitle);
      });

      if (!lesson) {
        return failure({
          kind: "execution" as const,
          tool: "lesson_get",
          message: `No lesson found with title: "${title}"`,
        });
      }

      // Publish status update about reading the lesson
      try {
        const conversation = context.conversationCoordinator.getConversation(context.conversationId);
        
        if (conversation?.history?.[0]) {
          const lessonTitle = lesson.title || title;
          const lessonNaddr = lesson.encode();
          await context.agentPublisher.conversation(
            { type: "conversation", content: `Reading [${lessonTitle}](nostr:${lessonNaddr})` },
            {
              triggeringEvent: context.triggeringEvent,
              rootEvent: conversation.history[0],
              conversationId: context.conversationId,
            }
          );
        }
      } catch (error) {
        // Don't fail the tool if we can't publish the status
        logger.warn("Failed to publish lesson_get status:", error);
      }

      logger.info("✅ Successfully retrieved lesson from memory", {
        agent: context.agent.name,
        agentPubkey: context.agent.pubkey,
        title: lesson.title || title,
        hasDetailed: !!lesson.detailed,
        phase: context.phase,
        conversationId: context.conversationId,
      });

      return success({
        title: lesson.title || title,
        lesson: lesson.lesson || lesson.content,
        detailed: lesson.detailed,
        category: lesson.category,
        hashtags: lesson.hashtags,
        hasDetailed: !!lesson.detailed,
      });
    } catch (error) {
      logger.error("❌ lesson_get tool failed", {
        error: formatAnyError(error),
        agent: context.agent.name,
        agentPubkey: context.agent.pubkey,
        title,
        phase: context.phase,
        conversationId: context.conversationId,
      });

      return failure({
        kind: "execution" as const,
        tool: "lesson_get",
        message: formatAnyError(error),
      });
    }
  },
};
