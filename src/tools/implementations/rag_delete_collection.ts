import type { ToolContext } from "@/tools/types";
import { RAGService } from "@/services/rag/RAGService";
import type { AISdkTool } from "@/tools/types";
import { type ToolResponse, executeToolWithErrorHandling } from "@/tools/utils";
import { tool } from "ai";
import { z } from "zod";

const ragDeleteCollectionSchema = z.object({
    name: z.string().describe("Name of the collection to delete"),
    confirm: z
        .boolean()
        .nullable()
        .default(false)
        .describe("Confirmation flag to prevent accidental deletion (must be true to proceed)"),
});

/**
 * Core implementation of RAG collection deletion
 */
async function executeDeleteCollection(
    input: z.infer<typeof ragDeleteCollectionSchema>,
    _context: ToolContext
): Promise<ToolResponse> {
    const { name, confirm = false } = input;

    if (!confirm) {
        return {
            success: false,
            error: "Deletion requires confirmation. Set confirm=true to proceed.",
            warning: `This will permanently delete the collection '${name}' and all its documents.`,
        };
    }

    const ragService = RAGService.getInstance();
    await ragService.deleteCollection(name);

    return {
        success: true,
        message: `Collection '${name}' has been permanently deleted`,
        deleted_collection: name,
    };
}

/**
 * Delete a RAG collection and all its documents
 */
export function createRAGDeleteCollectionTool(context: ToolContext): AISdkTool {
    return tool({
        description:
            "Delete a RAG collection and all its documents. This action is permanent and requires confirmation.",
        inputSchema: ragDeleteCollectionSchema,
        execute: async (input: unknown) => {
            return executeToolWithErrorHandling(
                "rag_delete_collection",
                input as z.infer<typeof ragDeleteCollectionSchema>,
                context,
                executeDeleteCollection
            );
        },
    }) as AISdkTool;
} 
