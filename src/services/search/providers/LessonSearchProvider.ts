/**
 * LessonSearchProvider - Search provider for lessons.
 *
 * Queries the `lessons` RAG collection directly via RAGService
 * since lessons don't have a dedicated embedding service like
 * reports and conversations do.
 */

import { logger } from "@/utils/logger";
import { RAGService, type RAGQueryResult } from "@/services/rag/RAGService";
import { buildProjectFilter } from "../projectFilter";
import type { SearchProvider, SearchResult } from "../types";

/** Collection name for lessons (matches what learn.ts uses) */
const LESSONS_COLLECTION = "lessons";

export class LessonSearchProvider implements SearchProvider {
    readonly name = "lessons";
    readonly description = "Agent lessons and insights";

    async search(
        query: string,
        projectId: string,
        limit: number,
        minScore: number
    ): Promise<SearchResult[]> {
        const ragService = RAGService.getInstance();

        // Check if the lessons collection exists
        const collections = await ragService.listCollections();
        if (!collections.includes(LESSONS_COLLECTION)) {
            logger.debug("[LessonSearchProvider] Lessons collection does not exist");
            return [];
        }

        const filter = buildProjectFilter(projectId);

        const results = await ragService.queryWithFilter(
            LESSONS_COLLECTION,
            query,
            limit * 2, // Request more to account for minScore filtering
            filter
        );

        logger.debug("[LessonSearchProvider] Search complete", {
            query,
            projectId,
            rawResults: results.length,
        });

        return results
            .filter((result: RAGQueryResult) => result.score >= minScore)
            .slice(0, limit)
            .map((result: RAGQueryResult) => this.transformResult(result, projectId));
    }

    private transformResult(result: RAGQueryResult, fallbackProjectId: string): SearchResult {
        const metadata = result.document.metadata || {};

        return {
            source: this.name,
            id: result.document.id || "",
            projectId: String(metadata.projectId || fallbackProjectId),
            relevanceScore: result.score,
            title: String(metadata.title || ""),
            summary: result.document.content?.substring(0, 200) || "",
            createdAt: metadata.timestamp ? Number(metadata.timestamp) : undefined,
            author: String(metadata.agentPubkey || ""),
            authorName: String(metadata.agentName || ""),
            tags: Array.isArray(metadata.hashtags) ? (metadata.hashtags as string[]) : undefined,
            retrievalTool: "lesson_get" as const,
            retrievalArg: result.document.id || "",
        };
    }
}
