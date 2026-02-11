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
            "Optional agent pubkey to filter lessons by. If not provided, returns only your own lessons."
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
 * Normalizes a pubkey string: trims whitespace and lowercases.
 * Returns the normalized value, or undefined if input is empty/whitespace.
 */
function normalizePubkey(pubkey: string | undefined): string | undefined {
    if (!pubkey) return undefined;
    const trimmed = pubkey.trim();
    if (trimmed === "") return undefined;
    return trimmed.toLowerCase();
}

/**
 * Validates that a string is a valid hex pubkey (64 hex characters).
 * Returns null if valid, error message if invalid.
 * Expects pre-normalized input (trimmed, lowercased).
 */
function validateAgentPubkey(pubkey: string, originalInput: string): string | null {
    // Must be exactly 64 hex characters (already lowercased)
    if (!/^[0-9a-f]{64}$/.test(pubkey)) {
        return `Invalid agent pubkey format: "${originalInput}". Expected 64-character hex string`;
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

    // Normalize the input pubkey once - trim whitespace and lowercase
    const normalizedInputPubkey = normalizePubkey(agentPubkey);

    // Validate agentPubkey if provided (after normalization)
    if (agentPubkey !== undefined) {
        // Check if normalization resulted in empty (whitespace-only input)
        if (normalizedInputPubkey === undefined) {
            return createExpectedError("Agent pubkey cannot be empty");
        }
        const validationError = validateAgentPubkey(normalizedInputPubkey, agentPubkey);
        if (validationError) {
            return createExpectedError(validationError);
        }
    }

    // Determine effective pubkey: use normalized input or default to calling agent
    const effectivePubkey = normalizedInputPubkey ?? context.agent.pubkey;

    logger.info("📚 Listing lessons", {
        agent: context.agent.name,
        agentFilter: effectivePubkey,
        conversationId: context.conversationId,
    });

    const projectContext = getProjectContext();

    // Get lessons based on filter
    const rawLessons = projectContext.getLessonsForAgent(effectivePubkey);

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
        agentFilter: effectivePubkey,
        conversationId: context.conversationId,
    });

    return {
        success: true,
        lessons,
        totalCount: lessons.length,
        agentFilter: effectivePubkey,
    };
}

/**
 * AI SDK tool factory
 */
export function createLessonsListTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description:
            "List lessons learned by agents in the project. Returns only your own lessons by default, " +
            "including title, full lesson content, category, hashtags, and author (agent slug). " +
            "Optionally filter by agent pubkey to see lessons from a specific agent. " +
            "Results are sorted by creation date (most recent first). Use this to discover what lessons are available. " +
            "For lessons with detailed explanations, use lesson_get to retrieve the full detailed content.",
        inputSchema: lessonsListSchema,
        execute: async (input: LessonsListInput) => {
            return await executeLessonsList(input, context);
        },
    }) as AISdkTool;
}
