import type { ToolExecutionContext } from "@/tools/types";
import { getProjectContext } from "@/services/projects";
import type { AISdkTool } from "@/tools/types";
import { createExpectedError } from "@/tools/utils";
import { logger } from "@/utils/logger";
import { normalizeLessonEventId } from "@/utils/nostr-entity-parser";
import { formatLessonOutput, type FormattedLessonOutput } from "./lesson-formatter";
import { tool } from "ai";
import { z } from "zod";

const lessonGetSchema = z.object({
    eventId: z.string().describe(
        "The event ID of the lesson to retrieve."
    ),
});

type LessonGetInput = z.infer<typeof lessonGetSchema>;

// Type for expected error results
type LessonGetResult = FormattedLessonOutput | { type: "error-text"; text: string };

// Core implementation - fetches lesson by event ID
// Returns error-text for expected "not found" conditions
async function executeLessonGet(
    input: LessonGetInput,
    context: ToolExecutionContext
): Promise<LessonGetResult> {
    const { eventId: inputEventId } = input;

    const projectContext = getProjectContext();

    // Get all lessons upfront for both normalization fallback and lookup
    const allLessons = projectContext.getAllLessons();

    // Normalize the input to a canonical 64-char hex ID
    // Supports: hex IDs, hex prefixes, note1..., nevent1..., nostr: prefixed versions
    const normalizeResult = normalizeLessonEventId(inputEventId, allLessons);
    if (!normalizeResult.success) {
        // Invalid event ID format is an expected user error - return error-text
        return createExpectedError(normalizeResult.error);
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
        // "Lesson not found" is an expected condition - return error-text
        return createExpectedError(`No lesson found with event ID: "${eventId}"`);
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
            "Retrieve a lesson by its Nostr event ID." +
            "Returns full lesson content including detailed explanations if available. Use when you need to recall specific knowledge or patterns that have been previously documented.",
        inputSchema: lessonGetSchema,
        execute: async (input: LessonGetInput) => {
            return await executeLessonGet(input, context);
        },
    });

    return aiTool as AISdkTool;
}
