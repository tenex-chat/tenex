import type { ToolExecutionContext } from "@/tools/types";
import { RAGService } from "@/services/rag/RAGService";
import type { AISdkTool } from "@/tools/types";
import { type ToolResponse, executeToolWithErrorHandling } from "@/tools/utils";
import { tool } from "ai";
import { z } from "zod";

const ragListCollectionsSchema = z.object({
    include_stats: z
        .boolean()
        .nullable()
        .default(false)
        .describe("Whether to include statistics for each collection (document count, last updated timestamp)"),
});

/**
 * Core implementation of listing RAG collections
 */
async function executeListCollections(
    input: z.infer<typeof ragListCollectionsSchema>,
    context: ToolExecutionContext
): Promise<ToolResponse> {
    const { include_stats = false } = input;

    const ragService = RAGService.getInstance();
    const collections = await ragService.listCollections();

    if (!include_stats || collections.length === 0) {
        return {
            success: true,
            collections_count: collections.length,
            collections: collections,
        };
    }

    // Fetch stats for all collections with agent attribution
    const agentPubkey = context.agent.pubkey;
    const stats = await ragService.getAllCollectionStats(agentPubkey);

    // Build a lookup map for efficient access
    const statsMap = new Map(stats.map((s) => [s.name, s]));

    const collectionsWithStats = collections.map((name) => {
        const collectionStats = statsMap.get(name);
        return {
            name,
            total_documents: collectionStats?.totalDocCount ?? 0,
            agent_documents: collectionStats?.agentDocCount ?? 0,
        };
    });

    return {
        success: true,
        collections_count: collections.length,
        collections: collectionsWithStats,
    };
}

/**
 * List all available RAG collections
 */
export function createRAGListCollectionsTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description: "List all available RAG collections in the system",
        inputSchema: ragListCollectionsSchema,
        execute: async (input: unknown) => {
            return executeToolWithErrorHandling(
                "rag_list_collections",
                input as z.infer<typeof ragListCollectionsSchema>,
                context,
                executeListCollections
            );
        },
    }) as AISdkTool;
} 
