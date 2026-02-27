/**
 * GenericCollectionSearchProvider - Search provider for any RAG collection.
 *
 * Created dynamically for RAG collections that don't have a dedicated
 * specialized provider. Queries via RAGService with basic project-scoped
 * filtering.
 */

import { logger } from "@/utils/logger";
import { RAGService, type RAGQueryResult } from "@/services/rag/RAGService";
import { buildProjectFilter } from "../projectFilter";
import type { SearchProvider, SearchResult } from "../types";

export class GenericCollectionSearchProvider implements SearchProvider {
    readonly name: string;
    readonly description: string;

    /** The actual RAG collection name to query */
    readonly collectionName: string;

    constructor(collectionName: string) {
        this.collectionName = collectionName;
        this.name = collectionName;
        this.description = `RAG collection: ${collectionName}`;
    }

    async search(
        query: string,
        projectId: string,
        limit: number,
        minScore: number
    ): Promise<SearchResult[]> {
        const ragService = RAGService.getInstance();

        const filter = buildProjectFilter(projectId);

        const results = await ragService.queryWithFilter(
            this.collectionName,
            query,
            limit * 2, // Request more to account for minScore filtering
            filter
        );

        logger.debug(`[GenericSearchProvider:${this.collectionName}] Search complete`, {
            query,
            projectId,
            rawResults: results.length,
        });

        const filtered = results
            .filter((result: RAGQueryResult) => result.score >= minScore && !!result.document.id)
            .slice(0, limit)
            .map((result: RAGQueryResult) => this.transformResult(result, projectId));

        if (filtered.length < results.length) {
            const dropped = results.length - filtered.length;
            logger.debug(`[GenericSearchProvider:${this.collectionName}] Dropped ${dropped} result(s) (low score or missing ID)`);
        }

        return filtered;
    }

    private transformResult(result: RAGQueryResult, fallbackProjectId: string): SearchResult {
        const metadata = result.document.metadata || {};

        return {
            source: this.collectionName,
            id: result.document.id || "",
            projectId: String(metadata.projectId || fallbackProjectId),
            relevanceScore: result.score,
            title: String(metadata.title || result.document.id || ""),
            summary: result.document.content?.substring(0, 200) || "",
            createdAt: metadata.timestamp ? Number(metadata.timestamp) : undefined,
            author: metadata.agentPubkey ? String(metadata.agentPubkey) : undefined,
            authorName: metadata.agentName ? String(metadata.agentName) : undefined,
            tags: Array.isArray(metadata.hashtags) ? (metadata.hashtags as string[]) : undefined,
            retrievalTool: "search" as const,
            retrievalArg: result.document.id || "",
        };
    }
}
