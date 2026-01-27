import type { ToolExecutionContext } from "@/tools/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";
import { conversationEmbeddingService } from "@/conversations/search/embeddings";
import { ConversationStore } from "@/conversations/ConversationStore";

const conversationIndexSchema = z.object({
    action: z
        .enum(["index_all", "index_project", "index_one", "clear", "status"])
        .describe(
            "Action to perform: 'index_all' indexes all conversations, 'index_project' indexes current project, " +
            "'index_one' indexes a specific conversation, 'clear' removes all embeddings, 'status' shows index info"
        ),
    conversationId: z
        .string()
        .optional()
        .describe("Conversation ID to index (required for 'index_one' action)"),
    projectId: z
        .string()
        .optional()
        .describe("Project ID to index (optional for 'index_project' action, defaults to current)"),
});

type ConversationIndexInput = z.infer<typeof conversationIndexSchema>;

interface ConversationIndexOutput {
    success: boolean;
    action: string;
    message: string;
    details?: {
        indexed?: number;
        embeddingModel?: string;
        hasIndex?: boolean;
    };
}

async function executeConversationIndex(
    input: ConversationIndexInput,
    context: ToolExecutionContext
): Promise<ConversationIndexOutput> {
    const { action, conversationId, projectId } = input;

    logger.info("📇 Conversation indexing", {
        action,
        conversationId: conversationId?.substring(0, 8),
        projectId,
        agent: context.agent.name,
    });

    try {
        switch (action) {
            case "index_all": {
                const indexed = await conversationEmbeddingService.indexAllConversations();
                return {
                    success: true,
                    action,
                    message: `Indexed ${indexed} conversations across all projects`,
                    details: { indexed },
                };
            }

            case "index_project": {
                const targetProjectId = projectId || ConversationStore.getProjectId();
                if (!targetProjectId) {
                    return {
                        success: false,
                        action,
                        message: "No project ID available",
                    };
                }
                const indexed = await conversationEmbeddingService.indexProjectConversations(targetProjectId);
                return {
                    success: true,
                    action,
                    message: `Indexed ${indexed} conversations for project ${targetProjectId}`,
                    details: { indexed },
                };
            }

            case "index_one": {
                if (!conversationId) {
                    return {
                        success: false,
                        action,
                        message: "conversationId is required for index_one action",
                    };
                }
                const targetProjectId = projectId || ConversationStore.getProjectId();
                if (!targetProjectId) {
                    return {
                        success: false,
                        action,
                        message: "No project ID available",
                    };
                }
                await conversationEmbeddingService.indexConversation(conversationId, targetProjectId);
                return {
                    success: true,
                    action,
                    message: `Indexed conversation ${conversationId.substring(0, 8)}`,
                    details: { indexed: 1 },
                };
            }

            case "clear": {
                await conversationEmbeddingService.clearIndex();
                return {
                    success: true,
                    action,
                    message: "Cleared conversation embeddings index",
                };
            }

            case "status": {
                const hasIndex = await conversationEmbeddingService.hasIndexedConversations();
                let embeddingModel = "unknown";
                try {
                    embeddingModel = await conversationEmbeddingService.getEmbeddingInfo();
                } catch {
                    // Ignore if not initialized
                }
                return {
                    success: true,
                    action,
                    message: hasIndex
                        ? "Conversation embeddings index is available"
                        : "No conversation embeddings indexed yet",
                    details: {
                        hasIndex,
                        embeddingModel,
                    },
                };
            }

            default:
                return {
                    success: false,
                    action,
                    message: `Unknown action: ${action}`,
                };
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Conversation indexing failed", { action, error: message });
        return {
            success: false,
            action,
            message: `Indexing failed: ${message}`,
        };
    }
}

export function createConversationIndexTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Manage conversation embeddings index for semantic search. " +
            "Use 'index_all' to build the full index (run once initially), " +
            "'index_project' to index only current project conversations, " +
            "'index_one' to update a specific conversation, " +
            "'clear' to remove all embeddings, or 'status' to check index availability. " +
            "The index enables semantic search in conversation_search tool with mode='semantic'.",

        inputSchema: conversationIndexSchema,

        execute: async (input: ConversationIndexInput) => {
            return await executeConversationIndex(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ action, conversationId, projectId }: ConversationIndexInput) => {
            switch (action) {
                case "index_all":
                    return "Indexing all conversations for semantic search";
                case "index_project":
                    return `Indexing conversations for project ${projectId || "(current)"}`;
                case "index_one":
                    return `Indexing conversation ${conversationId?.substring(0, 8) || "(missing)"}`;
                case "clear":
                    return "Clearing conversation embeddings index";
                case "status":
                    return "Checking conversation index status";
                default:
                    return `Conversation index action: ${action}`;
            }
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
