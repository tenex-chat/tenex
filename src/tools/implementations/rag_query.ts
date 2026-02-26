import type { ToolExecutionContext } from "@/tools/types";
import { type RAGQueryResult, RAGService } from "@/services/rag/RAGService";
import type { AISdkTool } from "@/tools/types";
import { type ToolResponse, executeToolWithErrorHandling } from "@/tools/utils";
import { tool } from "ai";
import { z } from "zod";

const ragQuerySchema = z.object({
    description: z
        .string()
        .trim()
        .min(1, "Description is required and cannot be empty")
        .describe(
            "REQUIRED: A clear, concise description of why you're querying this collection (5-10 words). Helps provide human-readable context for the operation."
        ),
    collection: z.string().describe("Name of the collection to query"),
    query_text: z.string().describe("The text query for semantic search"),
    top_k: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Number of top results to return (default: 5, range: 1-100)"),
    include_metadata: z
        .boolean()
        .optional()
        .describe("Whether to include document metadata in results (default: true)"),
});

/**
 * Formatted result for tool response
 */
interface FormattedQueryResult {
    rank: number;
    score: number;
    content: string;
    metadata?: Record<string, unknown>;
    source?: string;
    id?: string;
    timestamp?: string;
}

/**
 * Format query results for response
 */
function formatResults(
    results: RAGQueryResult[],
    includeMetadata: boolean
): FormattedQueryResult[] {
    return results.map((result, index) => ({
        rank: index + 1,
        score: result.score,
        content:
            result.document.content.length > 500
                ? `${result.document.content.substring(0, 500)}...`
                : result.document.content,
        ...(includeMetadata && {
            metadata: result.document.metadata,
            source: result.document.source,
            id: result.document.id,
            timestamp: result.document.timestamp
                ? new Date(result.document.timestamp).toISOString()
                : undefined,
        }),
    }));
}

/**
 * Core implementation of RAG semantic search
 */
async function executeQuery(
    input: z.infer<typeof ragQuerySchema>,
    _context: ToolExecutionContext
): Promise<ToolResponse> {
    const { collection, query_text } = input;

    // Use provided top_k or default to 5
    // The schema already validates the range (1-100) and integer constraint
    const topK = input.top_k ?? 5;
    const includeMetadata = input.include_metadata ?? true;

    const ragService = RAGService.getInstance();
    const results = await ragService.query(collection, query_text, topK);

    return {
        success: true,
        collection: collection,
        query: query_text,
        results_count: results.length,
        results: formatResults(results, includeMetadata),
    };
}

/**
 * Query a RAG collection using semantic search
 */
export function createRAGQueryTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description:
            "Perform semantic search on a RAG collection. Returns the most relevant documents based on vector similarity to the query.",
        inputSchema: ragQuerySchema,
        execute: async (input: unknown) => {
            return executeToolWithErrorHandling("rag_query", input as z.infer<typeof ragQuerySchema>, context, executeQuery);
        },
    }) as AISdkTool;
} 
