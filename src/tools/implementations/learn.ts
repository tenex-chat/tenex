import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import type { EventContext, LessonIntent } from "@/nostr/types";
import { RAGService } from "@/services/rag/RAGService";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const lessonLearnSchema = z.object({
    title: z.string().describe("Brief title/description of what this lesson is about"),
    lesson: z.string().describe("The lesson learned — include all relevant context and detail"),
    category: z
        .string()
        .optional()
        .describe(
            "Single category for filing this lesson (e.g., 'architecture', 'debugging', 'user-preferences')"
        ),
    hashtags: z
        .array(z.string())
        .default([])
        .describe("Hashtags for easier sorting and discovery (e.g., ['async', 'error-handling'])"),
});

type LessonLearnInput = z.infer<typeof lessonLearnSchema>;
type LessonLearnOutput = {
    ok: boolean;
};

// Core implementation - extracted from existing execute function
async function executeLessonLearn(
    input: LessonLearnInput,
    context: ToolExecutionContext
): Promise<LessonLearnOutput> {
    const { title, lesson, category, hashtags } = input;

    logger.info("Agent recording new lesson", {
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
        category,
        hashtags,
    };

    // Create event context
    // Note: encodeLesson only uses addStandardTags which needs model/ralNumber
    // rootEvent.id is not used by lesson encoding
    const eventContext: EventContext = {
        triggeringEnvelope: context.triggeringEnvelope,
        rootEvent: {},
        conversationId: context.conversationId,
        model: context.agent.llmConfig,
        ralNumber: context.ralNumber,
    };

    // Use shared AgentPublisher instance from context to create and publish the lesson
    const lessonEvent = await context.agentPublisher.lesson(intent, eventContext);

    // Add lesson to RAG collection for semantic search
    const ragService = RAGService.getInstance();

    // Ensure the lessons collection exists
    const collections = await ragService.listCollections();
    if (!collections.includes("lessons")) {
        await ragService.createCollection("lessons");
    }

    // Get projectId for project-scoped search isolation
    const projectId = context.projectContext.project.tagId();

    await ragService.addDocuments("lessons", [
        {
            id: lessonEvent.encodedId ?? lessonEvent.id,
            content: lesson,
            metadata: {
                title,
                category,
                hashtags: hashtags.length > 0 ? hashtags : undefined,
                agentPubkey: context.agent.pubkey,
                agentName: context.agent.name,
                timestamp: Date.now(),
                type: "lesson",
                ...(projectId && { projectId }),
            },
        },
    ]);

    logger.info("Lesson added to RAG collection", {
        title,
        eventId: lessonEvent.encodedId ?? lessonEvent.id,
        agentName: context.agent.name,
    });

    return { ok: true };
}

// AI SDK tool factory
export function createLessonLearnTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description: `Record new lessons and insights for future reference. Use for content ABOUT YOUR BEHAVIOR, such as:
- Patterns in how you approach tasks
- Debugging workflows that work well
- User preferences and communication styles
- Behavioral adjustments when user requests changes
- Performance patterns in your tool usage
- Things to do differently in future work

Use when the user instructs you to remember something about YOUR BEHAVIOR or PREFERENCES, or when the user instructs you to change some behavior. Lessons persist across conversations and help build institutional memory. Categorize and tag appropriately for future discovery.

**CRITICAL:** Only use this for content ABOUT YOUR BEHAVIOR. For content about the project itself, write git-tracked docs under \`$PROJECT_BASE/docs/\`, use project-specific \`+\` files under \`$AGENT_HOME/projects/<project-id>/docs/\` for your own persistent project memory, or update the root \`AGENTS.md\` for team-shared conventions.

**NEVER use for:**
- Project conventions or patterns
- Architecture documentation
- Technical specifications
- Design decisions
- API documentation
- Any content that would help others understand the project`,
        inputSchema: lessonLearnSchema,
        execute: async (input: LessonLearnInput) => {
            return await executeLessonLearn(input, context);
        },
    }) as AISdkTool;
}
