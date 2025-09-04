import { tool } from 'ai';
import type { EventContext, LessonIntent } from "@/nostr/AgentEventEncoder";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";

const lessonLearnSchema = z.object({
  title: z.string().describe("Brief title/description of what this lesson is about"),
  lesson: z.string().describe("The key insight or lesson learned - be concise and actionable"),
  detailed: z
    .string()
    .nullable()
    .describe("Detailed version with richer explanation when deeper context is needed"),
  category: z
    .string()
    .nullable()
    .describe(
      "Single category for filing this lesson (e.g., 'architecture', 'debugging', 'user-preferences')"
    ),
  hashtags: z
    .array(z.string())
    .nullable()
    .describe("Hashtags for easier sorting and discovery (e.g., ['async', 'error-handling'])"),
});

type LessonLearnInput = z.infer<typeof lessonLearnSchema>;
type LessonLearnOutput = {
  message: string;
  eventId: string;
  title: string;
  hasDetailed: boolean;
};

// Core implementation - extracted from existing execute function
async function executeLessonLearn(input: LessonLearnInput, context: ExecutionContext): Promise<LessonLearnOutput> {
  const { title, lesson, detailed, category, hashtags } = input;

  logger.info("🎓 Agent recording new lesson", {
    agent: context.agent.name,
    agentPubkey: context.agent.pubkey,
    title,
    lessonLength: lesson.length,
    phase: context.phase,
    conversationId: context.conversationId,
  });

  // Create lesson intent
  const intent: LessonIntent = {
    type: "lesson",
    title,
    lesson,
    detailed,
    category,
    hashtags,
  };

  // Get conversation for the event context
  const conversation = context.conversationCoordinator.getConversation(context.conversationId);

  // Create event context
  const eventContext: EventContext = {
    triggeringEvent: context.triggeringEvent,
    rootEvent: conversation?.history[0] ?? context.triggeringEvent, // Use triggering event as fallback
    conversationId: context.conversationId,
  };

  // Use shared AgentPublisher instance from context to create and publish the lesson
  const lessonEvent = await context.agentPublisher.lesson(intent, eventContext);

  // Publish status message with the Nostr reference
  try {
    const conversation = context.conversationCoordinator.getConversation(context.conversationId);
    if (conversation?.history?.[0]) {
      const nostrReference = `nostr:${lessonEvent.encode()}`;
      await context.agentPublisher.conversation(
        { type: "conversation", content: `📚 Learning lesson: ${nostrReference}` },
        {
          triggeringEvent: context.triggeringEvent,
          rootEvent: conversation.history[0],
          conversationId: context.conversationId,
        }
      );
    }
  } catch (error) {
    // Don't fail the tool if we can't publish the status
    console.warn("Failed to publish learn status:", error);
  }

  const message = `✅ Lesson recorded: "${title}"${detailed ? " (with detailed version)" : ""}\n\nThis lesson will be available in future conversations to help avoid similar issues.`;

  return {
    message,
    eventId: lessonEvent.encode(),
    title,
    hasDetailed: !!detailed,
  };
}

// AI SDK tool factory
export function createLessonLearnTool(context: ExecutionContext): ReturnType<typeof tool> {
  return tool({
    description: "Record new lessons and insights for future reference. Use when discovering patterns, solutions, or important knowledge that should be preserved. Lessons persist across conversations and help build institutional memory. Include both concise lesson and detailed explanation when complexity warrants it. Categorize and tag appropriately for future discovery. Lessons become immediately available via lesson_get.",
    inputSchema: lessonLearnSchema,
    execute: async (input: LessonLearnInput) => {
      return await executeLessonLearn(input, context);
    },
  });
}

