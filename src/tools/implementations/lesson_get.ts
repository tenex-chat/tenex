import { tool } from 'ai';
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";

const lessonGetSchema = z.object({
  title: z.string().describe("Title of the lesson to retrieve"),
});

type LessonGetInput = z.infer<typeof lessonGetSchema>;
type LessonGetOutput = {
  title: string;
  lesson: string;
  detailed?: string;
  category?: string;
  hashtags?: string[];
  hasDetailed: boolean;
};

// Core implementation - extracted from existing execute function
async function executeLessonGet(input: LessonGetInput, context: ExecutionContext): Promise<LessonGetOutput> {
  const { title } = input;

  logger.info("📖 Agent retrieving lesson by title", {
    agent: context.agent.name,
    agentPubkey: context.agent.pubkey,
    title,
    phase: context.phase,
    conversationId: context.conversationId,
  });

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
    throw new Error(`No lesson found with title: "${title}"`);
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

  return {
    title: lesson.title || title,
    lesson: lesson.lesson || lesson.content,
    detailed: lesson.detailed,
    category: lesson.category,
    hashtags: lesson.hashtags,
    hasDetailed: !!lesson.detailed,
  };
}

// AI SDK tool factory
export function createLessonGetTool(): ReturnType<typeof tool> {
  return tool({
    description: "Retrieve the full version of a lesson by its title, including detailed explanation if available",
    inputSchema: lessonGetSchema,
    execute: async (input: LessonGetInput) => {
      return await executeLessonGet(input, context);
    },
  });
}

