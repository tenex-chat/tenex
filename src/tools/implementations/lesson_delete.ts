import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { getProjectContext } from "@/services/projects";
import { RAGService } from "@/services/rag/RAGService";
import { createExpectedError } from "@/tools/utils";
import { logger } from "@/utils/logger";
import { normalizeLessonEventId } from "@/utils/nostr-entity-parser";
import { tool } from "ai";
import { z } from "zod";

const lessonDeleteSchema = z.object({
    eventId: z.string().describe(
        "Nostr event ID of the lesson to delete. Supports full 64-char hex ID, 12-char hex prefix, or NIP-19 formats (note1.../nevent1...)."
    ),
    reason: z.string().optional().describe(
        "Optional reason for deleting the lesson"
    ),
});

type LessonDeleteInput = z.infer<typeof lessonDeleteSchema>;

interface LessonDeleteOutput {
    success: boolean;
    eventId: string;
    title: string;
    message: string;
}

// Type for expected error results
type LessonDeleteResult = LessonDeleteOutput | { type: "error-text"; text: string };

/**
 * Core implementation of lesson deletion functionality.
 * Uses NIP-09 event deletion to mark the lesson as deleted.
 */
async function executeLessonDelete(
    input: LessonDeleteInput,
    context: ToolExecutionContext
): Promise<LessonDeleteResult> {
    const { eventId: inputEventId, reason } = input;

    const projectContext = getProjectContext();

    // Get all lessons for normalization and lookup
    const allLessons = projectContext.getAllLessons();

    // Normalize the input to a canonical 64-char hex ID
    const normalizeResult = normalizeLessonEventId(inputEventId, allLessons);
    if (!normalizeResult.success) {
        return createExpectedError(normalizeResult.error);
    }

    const eventId = normalizeResult.eventId;

    logger.info("🗑️ Agent deleting lesson", {
        agent: context.agent.name,
        agentPubkey: context.agent.pubkey,
        inputEventId,
        resolvedEventId: eventId,
        reason,
        conversationId: context.conversationId,
    });

    // Find the lesson by event ID - only allow deleting own lessons
    const agentLessons = projectContext.getLessonsForAgent(context.agent.pubkey);
    const lesson = agentLessons.find((l) => l.id === eventId);

    if (!lesson) {
        // Check if the lesson exists but belongs to another agent
        const globalLesson = allLessons.find((l) => l.id === eventId);
        if (globalLesson) {
            return createExpectedError(
                `Cannot delete lesson "${eventId}": You can only delete your own lessons.`
            );
        }
        return createExpectedError(`No lesson found with event ID: "${eventId}"`);
    }

    const lessonTitle = lesson.title || "Untitled";

    // Use NDK's delete method (NIP-09) to create a deletion event
    // Per error handling contract: unexpected failures from delete() should throw
    await lesson.delete(reason, true);

    logger.info("✅ Lesson deletion event published", {
        agent: context.agent.name,
        agentPubkey: context.agent.pubkey,
        eventId,
        title: lessonTitle,
        reason,
        conversationId: context.conversationId,
    });

    // Remove from RAG collection
    try {
        const ragService = RAGService.getInstance();
        await ragService.deleteDocumentById("lessons", lesson.encode());

        logger.info("📚 Lesson removed from RAG collection", {
            eventId,
            title: lessonTitle,
            agent: context.agent.name,
        });
    } catch (error) {
        // Don't fail the tool if RAG cleanup fails - the lesson is already deleted
        logger.warn("Failed to remove lesson from RAG collection", {
            error,
            eventId,
            title: lessonTitle,
        });
    }

    // Remove from project context cache (also triggers prompt recompilation)
    projectContext.removeLesson(context.agent.pubkey, eventId);

    return {
        success: true,
        eventId,
        title: lessonTitle,
        message: `Lesson "${lessonTitle}" has been deleted${reason ? ` (reason: ${reason})` : ""}.`,
    };
}

/**
 * Create an AI SDK tool for deleting lessons
 */
export function createLessonDeleteTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Delete a lesson by its Nostr event ID. This creates a deletion event (NIP-09) " +
            "to mark the lesson as deleted. Only lessons created by the calling agent can be deleted.\n\n" +
            "Supports multiple ID formats:\n" +
            "- Full 64-character hex IDs\n" +
            "- 12-character hex prefixes\n" +
            "- NIP-19 formats: note1..., nevent1...\n" +
            "- nostr: prefixed versions of all the above\n\n" +
            "Use when a lesson is no longer relevant, contains outdated information, or was recorded in error.",
        inputSchema: lessonDeleteSchema,
        execute: async (input: LessonDeleteInput) => {
            return await executeLessonDelete(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ eventId }: LessonDeleteInput) => {
            return `Deleting lesson: ${eventId}`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
