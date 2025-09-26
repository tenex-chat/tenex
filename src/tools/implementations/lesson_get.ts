import { tool } from 'ai';
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";
import { RAGService } from '@/services/rag/RAGService';

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

  // First, try to use RAG for semantic search
  try {
    const ragService = RAGService.getInstance();
    
    // Query the lessons collection using semantic search
    const searchResults = await ragService.query('lessons', title, 3);
    
    if (searchResults && searchResults.length > 0) {
      // Use the best matching result
      const bestMatch = searchResults[0];
      
      logger.info("✅ Found lesson via RAG semantic search", {
        agent: context.agent.name,
        agentPubkey: context.agent.pubkey,
        title: bestMatch.metadata?.title || title,
        similarity: bestMatch.similarity,
        conversationId: context.conversationId,
      });
      
      // Extract lesson data from metadata
      const metadata = bestMatch.metadata || {};
      return {
        title: metadata.title || title,
        lesson: bestMatch.content,
        detailed: metadata.hasDetailed ? bestMatch.content : undefined,
        category: metadata.category,
        hashtags: metadata.hashtags,
        hasDetailed: !!metadata.hasDetailed,
      };
    }
  } catch (error) {
    logger.debug("RAG search failed or no results, falling back to in-memory search", { error });
  }

  // Fallback to in-memory search if RAG fails or returns no results
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
export function createLessonGetTool(context: ExecutionContext) {
  const aiTool = tool({
    description: "Retrieve lessons learned from previous work by title. Lessons are knowledge persisted from past agent experiences. Search is case-insensitive and supports partial matches. Returns full lesson content including detailed explanations if available. Use when you need to recall specific knowledge or patterns that have been previously documented. Lessons are agent-specific and stored in memory.",
    inputSchema: lessonGetSchema,
    execute: async (input: LessonGetInput) => {
      return await executeLessonGet(input, context);
    },
  });

  Object.defineProperty(aiTool, 'getHumanReadableContent', {
    value: ({ title }: LessonGetInput) => {
      return `Reading lesson: ${title}`;
    },
    enumerable: false,
    configurable: true
  });

  return aiTool;
}

