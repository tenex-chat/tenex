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
        .describe("Whether to include per-collection statistics (total document count, your document count)"),
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

    if (!include_stats) {
        const collections = await ragService.listCollections();
        return {
            success: true,
            collections_count: collections.length,
            collections: collections,
        };
    }

    // Fetch stats for all collections with agent attribution
    // getAllCollectionStats already calls listCollections internally
    const agentPubkey = context.agent.pubkey;
    const stats = await ragService.getAllCollectionStats(agentPubkey);

    const collectionsWithStats = stats.map((s) => ({
        name: s.name,
        total_documents: s.totalDocCount,
        agent_documents: s.agentDocCount,
    }));

    return {
        success: true,
        collections_count: stats.length,
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
