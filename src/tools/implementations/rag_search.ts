/**
 * RAG Search Tool
 *
 * Single search tool that queries across ALL accessible RAG collections.
 * Specialized providers handle well-known collections (conversations, lessons)
 * with smart filtering, while dynamically discovered collections are
 * queried via generic providers with basic project-scoped filtering.
 *
 * Supports optional prompt-based LLM extraction for focused information retrieval.
 */

import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { bootstrapSearchProviders, UnifiedSearchService } from "@/services/search";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const ragSearchSchema = z.object({
    query: z.string().describe(
        "Natural language search query. Searches across all project knowledge " +
        "including conversations, lessons, and any additional RAG collections. " +
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
            "Filter by provider name. When omitted, searches all collections matching the " +
            "agent's scope (global + project + personal). When provided, searches exactly " +
            "those collections (no scope filtering — the agent explicitly chose them). " +
            "Well-known provider names: 'conversations', 'lessons'. " +
            "Dynamically discovered RAG collections use their collection name as the " +
            "provider name (e.g., 'custom_knowledge')."
        ),
});

type RAGSearchInput = z.infer<typeof ragSearchSchema>;

async function executeRAGSearch(
    input: RAGSearchInput,
    context: ToolExecutionContext
): Promise<Record<string, unknown>> {
    const { query, prompt, limit = 10, collections } = input;

    const projectId = context.projectContext.project.tagId();

    logger.info("🔍 [RAGSearch] Executing unified search", {
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
        agentPubkey: context.agent.pubkey,
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

export function createRAGSearchTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Search across indexed project knowledge — conversations, lessons, and any " +
            "additional RAG collections — using natural language semantic search. Returns ranked " +
            "results with metadata and retrieval instructions. Each result includes a `retrievalTool` " +
            "and `retrievalArg` that you can use to fetch the full document (e.g., call " +
            "conversation_get with the conversation ID, or rag_search against a specific collection).\n\n" +
            "Optionally provide a `prompt` parameter to have an LLM extract focused information " +
            "from the search results, rather than reviewing them manually.\n\n" +
            "This is the primary discovery tool for finding information across the project. Use " +
            "conversation_search for deep exploration of specific conversation content.",

        inputSchema: ragSearchSchema,

        execute: async (input: RAGSearchInput) => {
            return await executeRAGSearch(input, context);
        },
    });

    return aiTool as AISdkTool;
}
