/**
 * ReportEmbeddingService - Semantic search for reports
 *
 * Indexes NDKArticle reports (kind:30023) into a project-scoped RAG collection
 * for semantic discovery. Follows the same patterns as ConversationEmbeddingService.
 *
 * Key features:
 * - Project-scoped: reports are tagged with projectId for isolation
 * - Index on write: called from report_write tool after successful publish
 * - Upsert semantics: re-indexing updates existing documents (by slug + projectId)
 * - Graceful degradation: RAG failures don't break report writes
 * - Nostr remains authoritative source; RAG is just a search layer
 */

import { logger } from "@/utils/logger";
import { RAGService, type RAGDocument, type RAGQueryResult } from "@/services/rag/RAGService";
import type { ReportInfo } from "./ReportService";

/** Collection name for report embeddings */
const REPORT_COLLECTION = "project_reports";

/**
 * Result from semantic search on reports
 */
export interface ReportSearchResult {
    slug: string;
    projectId: string;
    title: string;
    summary?: string;
    author: string;
    publishedAt?: number;
    hashtags?: string[];
    relevanceScore: number;
}

/**
 * Options for semantic search on reports
 */
export interface ReportSearchOptions {
    limit?: number;
    minScore?: number;
    projectId?: string; // Required for project isolation; 'ALL' for cross-project
}

/**
 * Service for managing report embeddings and semantic search.
 *
 * Reports are indexed with their projectId in metadata, enabling
 * project-scoped queries via SQL prefilter during vector search.
 */
export class ReportEmbeddingService {
    private static instance: ReportEmbeddingService | null = null;
    private ragService: RAGService;
    private initialized = false;
    private initializationPromise: Promise<void> | null = null;

    private constructor() {
        this.ragService = RAGService.getInstance();
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): ReportEmbeddingService {
        if (!ReportEmbeddingService.instance) {
            ReportEmbeddingService.instance = new ReportEmbeddingService();
        }
        return ReportEmbeddingService.instance;
    }

    /**
     * Initialize the service (creates collection if needed).
     * Clears initializationPromise on failure to allow retries.
     */
    public async initialize(): Promise<void> {
        if (this.initialized) return;
        if (this.initializationPromise) return this.initializationPromise;

        this.initializationPromise = this.doInitialize();
        try {
            await this.initializationPromise;
        } catch (error) {
            this.initializationPromise = null;
            throw error;
        }
    }

    private async doInitialize(): Promise<void> {
        try {
            logger.debug("Initializing ReportEmbeddingService");

            const collections = await this.ragService.listCollections();
            if (!collections.includes(REPORT_COLLECTION)) {
                await this.ragService.createCollection(REPORT_COLLECTION);
                logger.info(`Created report embeddings collection: ${REPORT_COLLECTION}`);
            }

            this.initialized = true;
            logger.info("ReportEmbeddingService initialized successfully");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("Failed to initialize ReportEmbeddingService", { error: message });
            throw new Error(`ReportEmbeddingService initialization failed: ${message}`, {
                cause: error,
            });
        }
    }

    /**
     * Ensure service is initialized before operations
     */
    private async ensureInitialized(): Promise<void> {
        if (!this.initialized) {
            await this.initialize();
        }
    }

    /**
     * Build a stable document ID for a report within a project.
     * Uses projectId + slug to ensure uniqueness and enable upserts.
     */
    private buildDocumentId(projectId: string, slug: string): string {
        return `report_${projectId}_${slug}`;
    }

    /**
     * Build embedding content from report fields.
     * Combines title, summary, and content for richer semantic matching.
     */
    private buildEmbeddingContent(report: {
        title?: string;
        summary?: string;
        content?: string;
        hashtags?: string[];
    }): string {
        const parts: string[] = [];

        if (report.title) {
            parts.push(`Title: ${report.title}`);
        }

        if (report.summary) {
            parts.push(`Summary: ${report.summary}`);
        }

        if (report.content) {
            // Truncate very long content to avoid excessive embedding costs
            const truncated =
                report.content.length > 2000
                    ? report.content.substring(0, 2000) + "..."
                    : report.content;
            parts.push(`Content: ${truncated}`);
        }

        if (report.hashtags && report.hashtags.length > 0) {
            parts.push(`Tags: ${report.hashtags.join(", ")}`);
        }

        return parts.join("\n\n");
    }

    /**
     * Index a report into the RAG collection.
     *
     * Called from report_write after successful Nostr publish.
     * Uses upsert semantics: if a report with the same slug already exists
     * in the project, it is updated rather than duplicated.
     *
     * @param report Report data to index
     * @param projectId Project scope for isolation
     * @param agentPubkey Author's pubkey for attribution
     * @param agentName Author's display name
     * @returns true if indexing succeeded, false otherwise
     */
    public async indexReport(
        report: {
            slug: string;
            title: string;
            summary?: string;
            content: string;
            hashtags?: string[];
            publishedAt?: number;
        },
        projectId: string,
        agentPubkey: string,
        agentName?: string
    ): Promise<boolean> {
        await this.ensureInitialized();

        try {
            const documentId = this.buildDocumentId(projectId, report.slug);
            const embeddingContent = this.buildEmbeddingContent(report);

            if (!embeddingContent.trim()) {
                logger.debug("No content to embed for report", { slug: report.slug });
                return false;
            }

            // Delete existing document before inserting (upsert semantics)
            try {
                await this.ragService.deleteDocumentById(REPORT_COLLECTION, documentId);
            } catch {
                // Document might not exist - that's fine
            }

            const document: RAGDocument = {
                id: documentId,
                content: embeddingContent,
                metadata: {
                    slug: report.slug,
                    projectId,
                    title: report.title || "",
                    summary: report.summary || "",
                    hashtags: report.hashtags,
                    agentPubkey,
                    agentName: agentName || "",
                    type: "report",
                    publishedAt: report.publishedAt ?? Math.floor(Date.now() / 1000),
                },
                timestamp: Math.floor(Date.now() / 1000),
                source: "report",
            };

            await this.ragService.addDocuments(REPORT_COLLECTION, [document]);

            logger.info("📝 Report indexed in RAG", {
                slug: report.slug,
                projectId,
                documentId,
                agentName,
            });

            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("Failed to index report in RAG", {
                slug: report.slug,
                projectId,
                error: message,
            });
            return false;
        }
    }

    /**
     * Remove a report from the RAG collection.
     * Called when a report is deleted.
     */
    public async removeReport(slug: string, projectId: string): Promise<void> {
        try {
            // Check if the collection exists before attempting deletion.
            // Avoids ensureInitialized() which would create the collection as a side-effect.
            const collections = await this.ragService.listCollections();
            if (!collections.includes(REPORT_COLLECTION)) {
                logger.debug("Report collection does not exist, nothing to remove", {
                    slug,
                    projectId,
                });
                return;
            }

            const documentId = this.buildDocumentId(projectId, slug);
            await this.ragService.deleteDocumentById(REPORT_COLLECTION, documentId);
            logger.info("🗑️ Report removed from RAG", { slug, projectId, documentId });
        } catch (error) {
            logger.debug("Could not remove report from RAG (may not exist)", {
                slug,
                projectId,
                error,
            });
        }
    }

    /**
     * Build SQL prefilter for project isolation.
     * Applied DURING vector search, not after, to ensure proper project boundaries.
     */
    private buildProjectFilter(projectId?: string): string | undefined {
        if (!projectId || projectId.toLowerCase() === "all") {
            return undefined;
        }
        const escapedProjectId = projectId.replace(/'/g, "''");
        return `metadata LIKE '%"projectId":"${escapedProjectId}"%'`;
    }

    /**
     * Perform semantic search on reports within a project.
     *
     * @param query Natural language search query
     * @param options Search options including project isolation
     * @returns Array of matching reports with relevance scores
     */
    public async semanticSearch(
        query: string,
        options: ReportSearchOptions = {}
    ): Promise<ReportSearchResult[]> {
        await this.ensureInitialized();

        const { limit = 10, minScore = 0.3, projectId } = options;

        try {
            logger.info("🔍 Report semantic search", { query, limit, minScore, projectId });

            const filter = this.buildProjectFilter(projectId);

            const results = await this.ragService.queryWithFilter(
                REPORT_COLLECTION,
                query,
                limit * 2, // Request more to account for minScore filtering
                filter
            );

            const searchResults: ReportSearchResult[] = results
                .filter((result: RAGQueryResult) => result.score >= minScore)
                .slice(0, limit)
                .map((result: RAGQueryResult) => this.transformResult(result));

            logger.info("✅ Report semantic search complete", {
                query,
                found: searchResults.length,
                limit,
                projectFilter: filter || "none",
            });

            return searchResults;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("Report semantic search failed", { query, error: message });
            return [];
        }
    }

    /**
     * Transform RAG result to ReportSearchResult
     */
    private transformResult(result: RAGQueryResult): ReportSearchResult {
        const metadata = result.document.metadata || {};

        return {
            slug: String(metadata.slug || ""),
            projectId: String(metadata.projectId || ""),
            title: String(metadata.title || ""),
            summary: String(metadata.summary || ""),
            author: String(metadata.agentPubkey || ""),
            publishedAt: metadata.publishedAt ? Number(metadata.publishedAt) : undefined,
            hashtags: Array.isArray(metadata.hashtags) ? metadata.hashtags as string[] : undefined,
            relevanceScore: result.score,
        };
    }

    /**
     * Get the collection name for report embeddings.
     */
    public getCollectionName(): string {
        return REPORT_COLLECTION;
    }

    /**
     * Index multiple existing reports (bulk operation).
     * Useful for backfilling the RAG collection with existing reports.
     *
     * @param reports Array of ReportInfo objects
     * @param projectId Project scope for isolation
     * @returns Number of successfully indexed reports
     */
    public async indexExistingReports(
        reports: ReportInfo[],
        projectId: string
    ): Promise<number> {
        await this.ensureInitialized();

        let indexed = 0;
        for (const report of reports) {
            if (report.isDeleted) continue;
            if (!report.content) continue;

            const success = await this.indexReport(
                {
                    slug: report.slug,
                    title: report.title || "",
                    summary: report.summary,
                    content: report.content,
                    hashtags: report.hashtags,
                    publishedAt: report.publishedAt,
                },
                projectId,
                report.author
            );

            if (success) indexed++;
        }

        logger.info("📝 Bulk report indexing complete", {
            projectId,
            total: reports.length,
            indexed,
        });

        return indexed;
    }

    /**
     * Clear all report embeddings
     */
    public async clearIndex(): Promise<void> {
        try {
            await this.ragService.deleteCollection(REPORT_COLLECTION);
            logger.info("Cleared report embeddings index");
        } catch (error) {
            logger.debug("No report index to clear or error clearing", { error });
        }

        this.initialized = false;
        this.initializationPromise = null;
    }

    /**
     * Reset singleton instance (for testing)
     */
    public static resetInstance(): void {
        if (ReportEmbeddingService.instance) {
            ReportEmbeddingService.instance = null;
        }
    }
}

/** Lazy getter to avoid eagerly initializing at module load time */
export function getReportEmbeddingService(): ReportEmbeddingService {
    return ReportEmbeddingService.getInstance();
}
