/**
 * ConversationIndexingJob - Explicit batch indexing service
 *
 * This service indexes conversations that need embedding updates when called
 * by explicit operator commands. It tracks which conversations have been
 * indexed and ensures new/updated conversations are processed without
 * redundant embedding writes.
 *
 * Key features:
 * - Indexes conversations across all projects
 * - Tracks indexing state durably to avoid redundant work
 * - Re-indexes when conversation metadata changes
 * - Prevents overlapping batches
 * - Decoupled from ConversationRegistry for multi-project support
 */

import { logger } from "@/utils/logger";
import { getTenexBasePath } from "@/constants";
import { join } from "node:path";
import { ConversationCatalogService } from "@/conversations/ConversationCatalogService";
import { getConversationEmbeddingService } from "./ConversationEmbeddingService";
import type { BuildDocumentResult } from "./ConversationEmbeddingService";
import { IndexingStateManager } from "./IndexingStateManager";
import { listProjectIdsFromDisk, listConversationIdsFromDiskForProject } from "@/conversations/ConversationDiskReader";
import { RAGService, type RAGDocument } from "@/services/rag/RAGService";
import type { ProjectDTag } from "@/types/project-ids";

/**
 * Explicit conversation indexing job service
 */
export class ConversationIndexingJob {
    private static instance: ConversationIndexingJob | null = null;
    private isBatchRunning = false; // Prevent overlapping batches
    private projectsBasePath: string;
    private stateManager: IndexingStateManager;

    private constructor() {
        // Use stable projects root from config, not mutable registry
        this.projectsBasePath = join(getTenexBasePath(), "projects");
        this.stateManager = new IndexingStateManager(this.projectsBasePath);
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): ConversationIndexingJob {
        if (!ConversationIndexingJob.instance) {
            ConversationIndexingJob.instance = new ConversationIndexingJob();
        }
        return ConversationIndexingJob.instance;
    }

    /**
     * Run a single indexing batch.
     *
     * Collects all conversations needing re-indexing across all projects,
     * builds RAGDocuments for each, then flushes them via bulkUpsert
     * (mergeInsert). This creates one LanceDB version per chunk of
     * BATCH_SIZE instead of 2N versions (delete+insert per conversation).
     *
     * Failures are isolated per chunk: documents in a successful chunk are
     * marked indexed even when other chunks fail. Only truly failed
     * documents are retried next cycle.
     */
    public async indexPendingConversations(): Promise<void> {
        // Prevent overlapping batches
        if (this.isBatchRunning) {
            logger.warn("Skipping indexing batch - previous batch still running");
            return;
        }

        this.isBatchRunning = true;
        logger.debug("Running conversation indexing batch");

        const conversationEmbeddingService = getConversationEmbeddingService();

        try {
            // Ensure the embedding service is initialized
            await conversationEmbeddingService.initialize();

            let totalChecked = 0;
            let totalSkipped = 0;
            let totalFailed = 0;

            // Collect all documents that need indexing across all projects
            const pendingDocuments: RAGDocument[] = [];
            // Track which conversations were successfully built (for marking indexed after flush)
            // Indices into pendingDocuments correspond 1:1 with pendingMarkIndexed
            const pendingMarkIndexed: Array<{ projectId: ProjectDTag; conversationId: string }> = [];
            const pendingMarkNoContent: Array<{ projectId: ProjectDTag; conversationId: string }> = [];

            // Get all projects directly from disk
            const projectIds = listProjectIdsFromDisk(this.projectsBasePath);

            for (const projectId of projectIds) {
                ConversationCatalogService.getInstance(
                    projectId,
                    join(this.projectsBasePath, projectId)
                ).reconcile();

                const conversationIds = listConversationIdsFromDiskForProject(
                    this.projectsBasePath,
                    projectId
                );

                for (const conversationId of conversationIds) {
                    totalChecked++;

                    // Check if conversation needs indexing using durable state
                    const needsIndexing = this.stateManager.needsIndexing(
                        this.projectsBasePath,
                        projectId,
                        conversationId
                    );

                    if (!needsIndexing) {
                        totalSkipped++;
                        continue;
                    }

                    // Build document without writing
                    const result: BuildDocumentResult = conversationEmbeddingService.buildDocument(
                        conversationId,
                        projectId
                    );

                    switch (result.kind) {
                        case "ok":
                            pendingDocuments.push(result.document);
                            pendingMarkIndexed.push({ projectId, conversationId });
                            break;
                        case "noContent":
                            pendingMarkNoContent.push({ projectId, conversationId });
                            break;
                        case "error":
                            // Transient error — leave unmarked so it retries next cycle
                            totalFailed++;
                            logger.warn("Transient error building document, will retry", {
                                conversationId: conversationId.substring(0, 8),
                                projectId,
                                reason: result.reason,
                            });
                            break;
                    }
                }
            }

            // Flush all pending documents via bulkUpsert (per-chunk failure isolation)
            let totalIndexed = 0;
            if (pendingDocuments.length > 0) {
                const ragService = RAGService.getInstance();
                const collectionName = conversationEmbeddingService.getCollectionName();
                const { upsertedCount, failedIndices } = await ragService.bulkUpsert(
                    collectionName,
                    pendingDocuments
                );

                totalIndexed = upsertedCount;

                // Build a set of failed indices for O(1) lookup
                const failedSet = new Set(failedIndices);
                totalFailed += failedIndices.length;

                // Mark only successfully flushed conversations as indexed
                for (let i = 0; i < pendingMarkIndexed.length; i++) {
                    if (failedSet.has(i)) {
                        // This document's chunk failed — leave unmarked for retry
                        continue;
                    }
                    const { projectId, conversationId } = pendingMarkIndexed[i];
                    this.stateManager.markIndexed(
                        this.projectsBasePath,
                        projectId,
                        conversationId
                    );
                }
            }

            // Mark no-content conversations to avoid re-trying every batch
            for (const { projectId, conversationId } of pendingMarkNoContent) {
                this.stateManager.markIndexed(
                    this.projectsBasePath,
                    projectId,
                    conversationId,
                    true
                );
            }

            if (totalChecked > 0) {
                logger.info("Conversation indexing batch complete", {
                    projectsProcessed: projectIds.length,
                    conversationsChecked: totalChecked,
                    newlyIndexed: totalIndexed,
                    skipped: totalSkipped,
                    failed: totalFailed,
                });
            } else {
                logger.debug("No conversations to index in this batch");
            }
        } finally {
            this.isBatchRunning = false;
        }
    }

    /**
     * Force a full re-index of all conversations
     * This clears the tracking state and re-indexes everything
     */
    public async forceFullReindex(): Promise<void> {
        logger.info("Forcing full conversation re-index");
        this.stateManager.clearAllState();
        await this.indexPendingConversations();
    }

    /**
     * Get current job status
     */
    public getStatus(): {
        isBatchRunning: boolean;
        stateStats: ReturnType<IndexingStateManager["getStats"]>;
    } {
        return {
            isBatchRunning: this.isBatchRunning,
            stateStats: this.stateManager.getStats(),
        };
    }

    /**
     * Reset singleton instance (for testing)
     */
    public static resetInstance(): void {
        if (ConversationIndexingJob.instance) {
            ConversationIndexingJob.instance.stateManager.dispose();
            ConversationIndexingJob.instance = null;
        }
    }
}

// Export lazy getter to avoid eagerly initializing at module load time
export function getConversationIndexingJob(): ConversationIndexingJob {
    return ConversationIndexingJob.getInstance();
}
