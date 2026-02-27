/**
 * Unified Search Tool
 *
 * Single search tool that queries across ALL accessible RAG collections.
 * Specialized providers handle well-known collections (reports, conversations,
 * lessons) with smart filtering, while dynamically discovered collections are
 * queried via generic providers with basic project-scoped filtering.
 *
 * Supports optional prompt-based LLM extraction for focused information retrieval.
 */

import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import { bootstrapSearchProviders, UnifiedSearchService } from "@/services/search";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const searchSchema = z.object({
    query: z.string().describe(
        "Natural language search query. Searches across all project knowledge " +
        "including reports, conversations, lessons, and any additional RAG collections. " +
        "Use descriptive natural language for best results."
    ),
    prompt: z
        .string()
        .optional()
        .describe(
            "Optional extraction prompt. When provided, a fast LLM processes the search results " +
            "through the lens of this prompt to extract focused information. " +
            "Example: 'What decisions were made about the database schema?' " +
            "When absent, raw ranked results with metadata are returned."
        ),
    limit: z
        .number()
        .optional()
        .default(10)
        .describe("Maximum number of results to return across all collections. Defaults to 10."),
    collections: z
        .array(z.string())
        .optional()
        .describe(
            "Filter by provider name. Defaults to all available collections. " +
            "Well-known provider names: 'reports', 'conversations', 'lessons'. " +
            "Dynamically discovered RAG collections use their collection name as the " +
            "provider name (e.g., 'custom_knowledge'). " +
            "Use to narrow search scope when you know where the information lives."
        ),
});

type SearchInput = z.infer<typeof searchSchema>;

async function executeSearch(
    input: SearchInput,
    context: ToolExecutionContext
): Promise<Record<string, unknown>> {
    const { query, prompt, limit = 10, collections } = input;

    // Get project ID for scoping
    let projectId: string;
    if (isProjectContextInitialized()) {
        try {
            projectId = getProjectContext().project.tagId();
        } catch {
            return {
                success: false,
                error: "Project context not available. Cannot perform project-scoped search.",
            };
        }
    } else {
        return {
            success: false,
            error: "Project context not initialized. Cannot perform project-scoped search.",
        };
    }

    logger.info("🔍 [SearchTool] Executing unified search", {
        query,
        prompt: prompt ? `${prompt.substring(0, 50)}...` : undefined,
        limit,
        collections: collections || "all",
        projectId,
        agent: context.agent.name,
    });

    // Ensure providers are bootstrapped (idempotent)
    bootstrapSearchProviders();

    const searchService = UnifiedSearchService.getInstance();

    const result = await searchService.search({
        query,
        projectId,
        limit,
        prompt,
        collections,
    });

    // Format results for agent consumption
    return {
        success: result.success,
        query: result.query,
        totalResults: result.totalResults,
        collectionsSearched: result.collectionsSearched,
        ...(result.collectionsErrored && { collectionsErrored: result.collectionsErrored }),
        ...(result.warnings && { warnings: result.warnings }),
        ...(result.extraction && { extraction: result.extraction }),
        results: result.results.map((r) => ({
            source: r.source,
            id: r.id,
            relevanceScore: Math.round(r.relevanceScore * 1000) / 1000,
            title: r.title,
            summary: r.summary,
            ...(r.createdAt && { createdAt: r.createdAt }),
            ...(r.updatedAt && { updatedAt: r.updatedAt }),
            ...(r.author && { author: r.author }),
            ...(r.authorName && { authorName: r.authorName }),
            ...(r.tags?.length && { tags: r.tags }),
            retrievalTool: r.retrievalTool,
            retrievalArg: r.retrievalArg,
        })),
    };
}

export function createSearchTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Search across ALL project knowledge — reports, conversations, lessons, and any " +
            "additional RAG collections — using natural language semantic search. Returns ranked " +
            "results with metadata and retrieval instructions. Each result includes a `retrievalTool` " +
            "and `retrievalArg` that you can use to fetch the full document (e.g., call report_read " +
            "with the slug, lesson_get with the event ID, or conversation_get with the conversation ID).\n\n" +
            "Optionally provide a `prompt` parameter to have an LLM extract focused information " +
            "from the search results, rather than reviewing them manually.\n\n" +
            "This is the primary discovery tool for finding information across the project. Use " +
            "conversation_search for deep exploration of specific conversation content.",

        inputSchema: searchSchema,

        execute: async (input: SearchInput) => {
            return await executeSearch(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ query, prompt, limit, collections }: SearchInput) => {
            const parts = [`Searching project knowledge for "${query}"`];
            if (prompt) parts.push(`prompt: "${prompt.substring(0, 40)}..."`);
            if (collections?.length) parts.push(`in: ${collections.join(", ")}`);
            if (limit && limit !== 10) parts.push(`limit: ${limit}`);
            return parts.join(", ");
        },
        enumerable: false,
        configurable: true,
    });

    Object.defineProperty(aiTool, "hasSideEffects", {
        value: false,
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
