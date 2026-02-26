/**
 * ConversationSearchProvider - Search provider for conversations.
 *
 * Queries the `conversation_embeddings` RAG collection via ConversationEmbeddingService.
 */

import { logger } from "@/utils/logger";
import { getConversationEmbeddingService } from "@/conversations/search/embeddings";
import type { SearchProvider, SearchResult } from "../types";

export class ConversationSearchProvider implements SearchProvider {
    readonly name = "conversations";
    readonly description = "Past conversation threads and discussions";

    async search(
        query: string,
        projectId: string,
        limit: number,
        minScore: number
    ): Promise<SearchResult[]> {
        const conversationEmbeddingService = getConversationEmbeddingService();

        const results = await conversationEmbeddingService.semanticSearch(query, {
            limit,
            minScore,
            projectId,
        });

        logger.debug("[ConversationSearchProvider] Search complete", {
            query,
            projectId,
            found: results.length,
        });

        return results.map((result) => ({
            source: this.name,
            id: result.conversationId,
            projectId: result.projectId || projectId,
            relevanceScore: result.relevanceScore,
            title: result.title || "",
            summary: result.summary || "",
            createdAt: result.createdAt,
            updatedAt: result.lastActivity,
            retrievalTool: "conversation_get" as const,
            retrievalArg: result.conversationId,
        }));
    }
}
