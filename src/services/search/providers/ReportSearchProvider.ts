/**
 * ReportSearchProvider - Search provider for project reports.
 *
 * Queries the `project_reports` RAG collection via ReportEmbeddingService.
 */

import { logger } from "@/utils/logger";
import { getReportEmbeddingService } from "@/services/reports/ReportEmbeddingService";
import type { SearchProvider, SearchResult } from "../types";

export class ReportSearchProvider implements SearchProvider {
    readonly name = "reports";
    readonly description = "Project reports and documentation";

    async search(
        query: string,
        projectId: string,
        limit: number,
        minScore: number
    ): Promise<SearchResult[]> {
        const reportEmbeddingService = getReportEmbeddingService();

        const results = await reportEmbeddingService.semanticSearch(query, {
            limit,
            minScore,
            projectId,
        });

        logger.debug("[ReportSearchProvider] Search complete", {
            query,
            projectId,
            found: results.length,
        });

        return results.map((result) => ({
            source: this.name,
            id: result.slug,
            projectId: result.projectId,
            relevanceScore: result.relevanceScore,
            title: result.title,
            summary: result.summary || "",
            createdAt: result.publishedAt,
            author: result.author,
            tags: result.hashtags,
            retrievalTool: "report_read" as const,
            retrievalArg: result.slug,
        }));
    }
}
