import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { getProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import { createExpectedError } from "@/tools/utils";
import { formatLessonOutput } from "./lesson-formatter";
import { tool } from "ai";
import { z } from "zod";

const lessonsListSchema = z.object({
    agentPubkey: z
        .string()
        .optional()
        .describe(
            "Optional agent pubkey to filter lessons by. If not provided, returns lessons from all agents."
        ),
});

type LessonsListInput = z.infer<typeof lessonsListSchema>;

type LessonSummary = {
    eventId: string;
    title: string;
    lesson: string;
    category?: string;
    hashtags?: string[];
    author: string; // Agent slug or pubkey fallback
    hasDetailed: boolean;
    createdAt?: number;
};

type LessonsListOutput = {
    success: boolean;
    lessons: LessonSummary[];
    totalCount: number;
    agentFilter?: string;
};

type LessonsListResult = LessonsListOutput | { type: "error-text"; text: string };

/**
 * Validates that a string is a valid hex pubkey (64 lowercase hex characters).
 * Returns null if valid, error message if invalid.
 */
function validateAgentPubkey(pubkey: string | undefined): string | null {
    // Empty or whitespace-only strings are invalid
    if (!pubkey || pubkey.trim() === "") {
        return "Agent pubkey cannot be empty";
    }

    const trimmed = pubkey.trim();

    // Must be exactly 64 hex characters (lowercase or uppercase)
    if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        return `Invalid agent pubkey format: "${pubkey}". Expected 64-character hex string`;
    }

    return null;
}

/**
 * Core implementation - list lessons for the project
 */
async function executeLessonsList(
    input: LessonsListInput,
    context: ToolExecutionContext
): Promise<LessonsListResult> {
    const { agentPubkey } = input;

    // Validate agentPubkey if provided
    if (agentPubkey !== undefined) {
        const validationError = validateAgentPubkey(agentPubkey);
        if (validationError) {
            return createExpectedError(validationError);
        }
    }

    logger.info("📚 Listing lessons", {
        agent: context.agent.name,
        agentFilter: agentPubkey,
        conversationId: context.conversationId,
    });

    const projectContext = getProjectContext();

    // Get lessons based on filter
    const rawLessons = agentPubkey
        ? projectContext.getLessonsForAgent(agentPubkey)
        : projectContext.getAllLessons();

    // Transform lessons to summary format
    const lessons: LessonSummary[] = rawLessons.map((lesson) => {
        // Try to resolve author pubkey to agent slug (matching reports_list pattern)
        const agent = projectContext.getAgentByPubkey(lesson.pubkey);
        const authorSlug = agent?.slug ?? lesson.pubkey;

        // Use shared formatter for consistent lesson formatting
        const formatted = formatLessonOutput(lesson, lesson.id);

        return {
            ...formatted,
            author: authorSlug,
            createdAt: lesson.created_at,
        };
    });

    // Sort by creation date, most recent first
    lessons.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    logger.info("✅ Lessons listed successfully", {
        total: lessons.length,
        agent: context.agent.name,
        agentFilter: agentPubkey,
        conversationId: context.conversationId,
    });

    return {
        success: true,
        lessons,
        totalCount: lessons.length,
        agentFilter: agentPubkey,
    };
}

/**
 * AI SDK tool factory
 */
export function createLessonsListTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description:
            "List lessons learned by agents in the project. Returns all lessons including title, full lesson content, " +
            "category, hashtags, and author (agent slug). Optionally filter by agent pubkey to see lessons from a specific agent. " +
            "Results are sorted by creation date (most recent first). Use this to discover what lessons are available. " +
            "For lessons with detailed explanations, use lesson_get to retrieve the full detailed content.",
        inputSchema: lessonsListSchema,
        execute: async (input: LessonsListInput) => {
            return await executeLessonsList(input, context);
        },
    }) as AISdkTool;
}
