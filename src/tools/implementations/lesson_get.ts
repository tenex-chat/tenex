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

  // No longer publishing status update - using getHumanReadableContent instead

  logger.info("✅ Successfully retrieved lesson from memory", {
    agent: context.agent.name,
    agentPubkey: context.agent.pubkey,
    title: lesson.title || title,
    hasDetailed: !!lesson.detailed,
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
export function createLessonGetTool(context: ExecutionContext): ReturnType<typeof tool> {
  const toolInstance = tool({
    description: "Retrieve lessons learned from previous work by title. Lessons are knowledge persisted from past agent experiences. Search is case-insensitive and supports partial matches. Returns full lesson content including detailed explanations if available. Use when you need to recall specific knowledge or patterns that have been previously documented. Lessons are agent-specific and stored in memory.",
    inputSchema: lessonGetSchema,
    execute: async (input: LessonGetInput) => {
      return await executeLessonGet(input, context);
    },
  });

  // Add human-readable content generation
  return Object.assign(toolInstance, {
    getHumanReadableContent: ({ title }: LessonGetInput) => {
      return `Reading lesson: ${title}`;
    }
  });
}

