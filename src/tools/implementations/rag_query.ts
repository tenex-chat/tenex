import type { ExecutionContext } from "@/agents/execution/types";
import { type RAGQueryResult, RAGService } from "@/services/rag/RAGService";
import type { AISdkTool } from "@/tools/types";
import { type ToolResponse, executeToolWithErrorHandling, parseNumericInput } from "@/tools/utils";
import { tool } from "ai";
import { z } from "zod";

const ragQuerySchema = z.object({
    collection: z.string().describe("Name of the collection to query"),
    query_text: z.string().describe("The text query for semantic search"),
    top_k: z
        .number()
        .nullable()
        .default(5)
        .describe("Number of top results to return (default: 5)"),
    include_metadata: z
        .boolean()
        .nullable()
        .default(true)
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
    _context: ExecutionContext
): Promise<ToolResponse> {
    const { collection, query_text, include_metadata = true } = input;

    // Validate and parse top_k with constraints
    const topK = parseNumericInput(input.top_k, 5, { min: 1, max: 100, integer: true });

    const ragService = RAGService.getInstance();
    const results = await ragService.query(collection, query_text, topK);

    return {
        success: true,
        collection: collection,
        query: query_text,
        results_count: results.length,
        results: formatResults(results, include_metadata),
    };
}

/**
 * Query a RAG collection using semantic search
 */
export function createRAGQueryTool(context: ExecutionContext): AISdkTool {
    return tool({
        description:
            "Perform semantic search on a RAG collection. Returns the most relevant documents based on vector similarity to the query.",
        inputSchema: ragQuerySchema,
        execute: async (input: z.infer<typeof ragQuerySchema>) => {
            return executeToolWithErrorHandling("rag_query", input, context, executeQuery);
        },
    });
}
