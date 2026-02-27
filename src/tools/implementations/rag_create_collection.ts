import type { ToolExecutionContext } from "@/tools/types";
import { RAGService } from "@/services/rag/RAGService";
import { RAGCollectionRegistry } from "@/services/rag/RAGCollectionRegistry";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import type { AISdkTool } from "@/tools/types";
import { type ToolResponse, executeToolWithErrorHandling } from "@/tools/utils";
import { tool } from "ai";
import { z } from "zod";

const ragCreateCollectionSchema = z.object({
    description: z
        .string()
        .trim()
        .min(1, "Description is required and cannot be empty")
        .describe(
            "REQUIRED: A clear, concise description of why you're creating this collection (5-10 words). Helps provide human-readable context for the operation."
        ),
    name: z.string().describe("Name of the collection to create (alphanumeric with underscores)"),
    schema: z
        .record(z.string(), z.any())
        .nullable()
        .describe(
            "Optional custom schema for the collection (default includes id, content, vector, metadata, timestamp, source)"
        ),
    scope: z
        .enum(["global", "project", "personal"])
        .optional()
        .default("project")
        .describe(
            "Visibility scope for rag_search() auto-discovery. " +
            "'global' = visible to all agents in all projects. " +
            "'project' = visible to agents in this project (default). " +
            "'personal' = primarily relevant to the creating agent. " +
            "Note: This is NOT access control — agents can always query any collection explicitly."
        ),
});

/**
 * Core implementation of RAG collection creation
 */
async function executeCreateCollection(
    input: z.infer<typeof ragCreateCollectionSchema>,
    context: ToolExecutionContext
): Promise<ToolResponse> {
    const { name, schema, scope } = input;

    const ragService = RAGService.getInstance();
    const collection = await ragService.createCollection(name, schema ?? undefined);

    // Register in the collection registry with scope metadata
    const registry = RAGCollectionRegistry.getInstance();
    let projectId: string | undefined;
    if (isProjectContextInitialized()) {
        try {
            projectId = getProjectContext().project.tagId();
        } catch {
            // Project context not available — no projectId
        }
    }

    registry.register(name, {
        scope,
        projectId,
        agentPubkey: context.agent.pubkey,
    });

    return {
        success: true,
        message: `Collection '${name}' created successfully`,
        collection: {
            name: collection.name,
            created_at: new Date(collection.created_at).toISOString(),
            schema: collection.schema,
            scope,
        },
    };
}

/**
 * Create a new RAG collection for storing and retrieving vector embeddings
 */
export function createRAGCreateCollectionTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description:
            "Create a new RAG collection (vector database) for storing documents with semantic search capabilities. " +
            "Set scope to control default visibility in rag_search(): 'global' (all projects), " +
            "'project' (current project, default), or 'personal' (creating agent only).",
        inputSchema: ragCreateCollectionSchema,
        execute: async (input: unknown) => {
            return executeToolWithErrorHandling(
                "rag_create_collection",
                input as z.infer<typeof ragCreateCollectionSchema>,
                context,
                executeCreateCollection
            );
        },
    }) as AISdkTool;
}
