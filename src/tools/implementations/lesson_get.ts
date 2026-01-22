import type { ToolExecutionContext } from "@/tools/types";
import { getProjectContext } from "@/services/projects";
import type { AISdkTool } from "@/tools/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { logger } from "@/utils/logger";
import { normalizeLessonEventId } from "@/utils/nostr-entity-parser";
import { tool } from "ai";
import { z } from "zod";

const lessonGetSchema = z.object({
    eventId: z.string().describe("Nostr event ID of the lesson to retrieve. Supports full 64-char hex ID, 12-char hex prefix, or NIP-19 formats (note1.../nevent1...)."),
});

type LessonGetInput = z.infer<typeof lessonGetSchema>;
type LessonGetOutput = {
    eventId: string;
    title: string;
    lesson: string;
    detailed?: string;
    category?: string;
    hashtags?: string[];
    hasDetailed: boolean;
};

/**
 * Formats a lesson into the standard output shape for lesson_get.
 * Consolidates the output mapping to avoid DRY violations.
 */
function formatLessonOutput(lesson: NDKAgentLesson, eventId: string): LessonGetOutput {
    return {
        eventId,
        title: lesson.title || "Untitled",
        lesson: lesson.lesson || lesson.content,
        detailed: lesson.detailed,
        category: lesson.category,
        hashtags: lesson.hashtags,
        hasDetailed: !!lesson.detailed,
    };
}

// Core implementation - fetches lesson by event ID
async function executeLessonGet(
    input: LessonGetInput,
    context: ToolExecutionContext
): Promise<LessonGetOutput> {
    const { eventId: inputEventId } = input;

    const projectContext = getProjectContext();

    // Get all lessons upfront for both normalization fallback and lookup
    const allLessons = projectContext.getAllLessons();

    // Normalize the input to a canonical 64-char hex ID
    // Supports: hex IDs, hex prefixes, note1..., nevent1..., nostr: prefixed versions
    const normalizeResult = normalizeLessonEventId(inputEventId, allLessons);
    if (!normalizeResult.success) {
        throw new Error(normalizeResult.error);
    }

    const eventId = normalizeResult.eventId;

    logger.info("📖 Agent retrieving lesson by event ID", {
        agent: context.agent.name,
        agentPubkey: context.agent.pubkey,
        inputEventId,
        resolvedEventId: eventId,
        conversationId: context.conversationId,
    });

    // Find lesson by event ID - first try agent-specific, then global
    const agentLessons = projectContext.getLessonsForAgent(context.agent.pubkey);
    let lesson = agentLessons.find((l) => l.id === eventId);
    let isGlobalMatch = false;

    if (!lesson) {
        // Fall back to global search (in case agent pubkey doesn't match exactly)
        lesson = allLessons.find((l) => l.id === eventId);
        isGlobalMatch = true;
    }

    if (!lesson) {
        throw new Error(`No lesson found with event ID: "${eventId}"`);
    }

    logger.info("✅ Successfully retrieved lesson", {
        agent: context.agent.name,
        agentPubkey: context.agent.pubkey,
        eventId,
        title: lesson.title,
        hasDetailed: !!lesson.detailed,
        source: isGlobalMatch ? "global" : "agent",
        conversationId: context.conversationId,
    });

    return formatLessonOutput(lesson, eventId);
}

// AI SDK tool factory
export function createLessonGetTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Retrieve a lesson by its Nostr event ID. Supports multiple formats:\n" +
            "- Full 64-character hex IDs\n" +
            "- 12-character hex prefixes\n" +
            "- NIP-19 formats: note1..., nevent1...\n" +
            "- nostr: prefixed versions of all the above\n\n" +
            "Returns full lesson content including detailed explanations if available. Use when you need to recall specific knowledge or patterns that have been previously documented.",
        inputSchema: lessonGetSchema,
        execute: async (input: LessonGetInput) => {
            return await executeLessonGet(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ eventId }: LessonGetInput) => {
            return `Reading lesson: ${eventId}`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
