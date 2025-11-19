import type { ExecutionContext } from "@/agents/execution/types";
import type { EventContext, LessonIntent } from "@/nostr/AgentEventEncoder";
import { RAGService } from "@/services/rag/RAGService";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

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
async function executeLessonLearn(
    input: LessonLearnInput,
    context: ExecutionContext
): Promise<LessonLearnOutput> {
    const { title, lesson, detailed, category, hashtags } = input;

    if (!context.agentPublisher) {
        throw new Error("AgentPublisher not available in execution context");
    }

    logger.info("🎓 Agent recording new lesson", {
        agent: context.agent.name,
        agentPubkey: context.agent.pubkey,
        title,
        lessonLength: lesson.length,
        conversationId: context.conversationId,
    });

    // Create lesson intent
    const intent: LessonIntent = {
        title,
        lesson,
        detailed: detailed ?? undefined,
        category: category ?? undefined,
        hashtags,
    };

    // Get conversation for the event context
    const conversation = context.getConversation();

    // Create event context
    const eventContext: EventContext = {
        triggeringEvent: context.triggeringEvent,
        rootEvent: conversation?.history[0] ?? context.triggeringEvent, // Use triggering event as fallback
        conversationId: context.conversationId,
        model: context.agent.llmConfig, // Include LLM configuration
    };

    // Use shared AgentPublisher instance from context to create and publish the lesson
    const lessonEvent = await context.agentPublisher.lesson(intent, eventContext);

    // Publish status message with the Nostr reference
    try {
        const conversationForStatus = context.getConversation();
        if (conversationForStatus?.history?.[0]) {
            const nostrReference = `nostr:${lessonEvent.encode()}`;
            await context.agentPublisher.conversation(
                { content: `📚 Learning lesson: ${nostrReference}` },
                {
                    triggeringEvent: context.triggeringEvent,
                    rootEvent: conversationForStatus.history[0],
                    conversationId: context.conversationId,
                    model: context.agent.llmConfig, // Include LLM configuration
                }
            );
        }
    } catch (error) {
        // Don't fail the tool if we can't publish the status
        console.warn("Failed to publish learn status:", error);
    }

    // Add lesson to RAG collection for semantic search
    try {
        const ragService = RAGService.getInstance();

        // Ensure the lessons collection exists
        try {
            await ragService.createCollection("lessons");
        } catch (error) {
            // Collection might already exist, which is fine
            logger.debug("Lessons collection might already exist", { error });
        }

        // Add the lesson to the RAG collection
        const lessonContent = detailed || lesson;
        await ragService.addDocuments("lessons", [
            {
                id: lessonEvent.encode(),
                content: lessonContent,
                metadata: {
                    title,
                    category: category || undefined,
                    hashtags: hashtags || undefined,
                    agentPubkey: context.agent.pubkey,
                    agentName: context.agent.name,
                    timestamp: Date.now(),
                    hasDetailed: !!detailed,
                    type: "lesson",
                },
            },
        ]);

        logger.info("✅ Lesson added to RAG collection", {
            title,
            eventId: lessonEvent.encode(),
            agentName: context.agent.name,
        });
    } catch (error) {
        // Don't fail the tool if RAG integration fails
        logger.warn("Failed to add lesson to RAG collection", { error, title });
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
        description:
            "Record new lessons and insights for future reference. Use when discovering patterns, solutions, or important knowledge that should be preserved. ALWAYS use when the user instructs you to remember something or change some behavior. Lessons persist across conversations and help build institutional memory. Include both concise lesson and detailed explanation when complexity warrants it. Categorize and tag appropriately for future discovery. Lessons become immediately available via lesson_get.",
        inputSchema: lessonLearnSchema,
        execute: async (input: LessonLearnInput) => {
            return await executeLessonLearn(input, context);
        },
    });
}
