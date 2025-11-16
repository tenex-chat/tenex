import { tool } from "ai";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/registry";
import { RAGService } from "@/services/rag/RAGService";
import { 
    executeToolWithErrorHandling, 
    type ToolResponse 
} from "@/tools/utils";

const ragCreateCollectionSchema = z.object({
    name: z.string().describe(
        "Name of the collection to create (alphanumeric with underscores)"
    ),
    schema: z.record(z.string(), z.any()).nullable().describe(
        "Optional custom schema for the collection (default includes id, content, vector, metadata, timestamp, source)"
    ),
});

/**
 * Core implementation of RAG collection creation
 */
async function executeCreateCollection(
    input: z.infer<typeof ragCreateCollectionSchema>,
    _context: ExecutionContext
): Promise<ToolResponse> {
    const { name, schema } = input;
    
    const ragService = RAGService.getInstance();
    const collection = await ragService.createCollection(name, schema);
    
    return {
        success: true,
        message: `Collection '${name}' created successfully`,
        collection: {
            name: collection.name,
            created_at: new Date(collection.created_at).toISOString(),
            schema: collection.schema
        }
    };
}

/**
 * Create a new RAG collection for storing and retrieving vector embeddings
 */
export function createRAGCreateCollectionTool(context: ExecutionContext): AISdkTool {
    return tool({
        description: "Create a new RAG collection (vector database) for storing documents with semantic search capabilities",
        inputSchema: ragCreateCollectionSchema,
        execute: async (input: z.infer<typeof ragCreateCollectionSchema>) => {
            return executeToolWithErrorHandling(
                "rag_create_collection",
                input,
                context,
                executeCreateCollection
            );
        },
    });
}