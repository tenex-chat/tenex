/**
 * ConversationIndexingJob - Automatic batch indexing service
 *
 * This service runs periodically (every 5 minutes) to automatically index
 * conversations that need embedding updates. It tracks which conversations
 * have been indexed and ensures new/updated conversations are processed
 * without requiring manual agent intervention.
 *
 * Key features:
 * - Runs every 5 minutes as a background job
 * - Indexes conversations across all projects
 * - Tracks indexing state durably to avoid redundant work
 * - Re-indexes when conversation metadata changes
 * - Graceful error handling - failures don't break the service
 * - Prevents overlapping batches
 * - Decoupled from ConversationRegistry for multi-project support
 */

import { logger } from "@/utils/logger";
import { getTenexBasePath } from "@/constants";
import { join } from "path";
import { getConversationEmbeddingService } from "./ConversationEmbeddingService";
import type { BuildDocumentResult } from "./ConversationEmbeddingService";
import { IndexingStateManager } from "./IndexingStateManager";
import { listProjectIdsFromDisk, listConversationIdsFromDiskForProject } from "@/conversations/ConversationDiskReader";
import { RAGService, type RAGDocument } from "@/services/rag/RAGService";

/** Default interval: 5 minutes (in milliseconds) */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Automatic conversation indexing job service
 */
export class ConversationIndexingJob {
    private static instance: ConversationIndexingJob | null = null;
    private timer: NodeJS.Timeout | null = null;
    private isRunning = false;
    private isBatchRunning = false; // Prevent overlapping batches
    private intervalMs: number;
    private projectsBasePath: string;
    private stateManager: IndexingStateManager;

    private constructor(intervalMs: number = DEFAULT_INTERVAL_MS) {
        this.intervalMs = intervalMs;
        // Use stable projects root from config, not mutable registry
        this.projectsBasePath = join(getTenexBasePath(), "projects");
        this.stateManager = new IndexingStateManager(this.projectsBasePath);
    }

    /**
     * Get singleton instance
     */
    public static getInstance(intervalMs?: number): ConversationIndexingJob {
        if (!ConversationIndexingJob.instance) {
            ConversationIndexingJob.instance = new ConversationIndexingJob(intervalMs);
        }
        return ConversationIndexingJob.instance;
    }

    /**
     * Start the periodic indexing job
     */
    public start(): void {
        if (this.isRunning) {
            logger.warn("ConversationIndexingJob is already running");
            return;
        }

        this.isRunning = true;
        logger.info("Starting ConversationIndexingJob", {
            intervalMs: this.intervalMs,
            intervalMinutes: this.intervalMs / 60000,
            projectsBasePath: this.projectsBasePath,
        });

        // Run immediately on start
        this.scheduleNextBatch(0);
    }

    /**
     * Schedule the next batch run (self-scheduling to prevent overlaps)
     */
    private scheduleNextBatch(delayMs: number): void {
        if (!this.isRunning) return;

        this.timer = setTimeout(async () => {
            try {
                await this.runIndexingBatch();
            } catch (error) {
                logger.error("Indexing batch failed", { error });
            } finally {
                // Schedule next run only after this one completes
                this.scheduleNextBatch(this.intervalMs);
            }
        }, delayMs);
    }

    /**
     * Stop the periodic indexing job
     */
    public stop(): void {
        if (!this.isRunning) {
            logger.warn("ConversationIndexingJob is not running");
            return;
        }

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        this.isRunning = false;

        // Save state before stopping
        this.stateManager.dispose();

        logger.info("ConversationIndexingJob stopped");
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
    private async runIndexingBatch(): Promise<void> {
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
            const pendingMarkIndexed: Array<{ projectId: string; conversationId: string }> = [];
            const pendingMarkNoContent: Array<{ projectId: string; conversationId: string }> = [];

            // Get all projects directly from disk
            const projectIds = listProjectIdsFromDisk(this.projectsBasePath);

            for (const projectId of projectIds) {
                try {
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
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.error("Failed to process project conversations", {
                        projectId,
                        error: message,
                    });
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
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("Conversation indexing batch failed", { error: message });
            // Don't throw - we want the job to keep running even if one batch fails
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
        await this.runIndexingBatch();
    }

    /**
     * Get current job status
     */
    public getStatus(): {
        isRunning: boolean;
        isBatchRunning: boolean;
        intervalMs: number;
        stateStats: ReturnType<IndexingStateManager["getStats"]>;
    } {
        return {
            isRunning: this.isRunning,
            isBatchRunning: this.isBatchRunning,
            intervalMs: this.intervalMs,
            stateStats: this.stateManager.getStats(),
        };
    }

    /**
     * Reset singleton instance (for testing)
     */
    public static resetInstance(): void {
        if (ConversationIndexingJob.instance) {
            ConversationIndexingJob.instance.stop();
            ConversationIndexingJob.instance = null;
        }
    }
}

// Export lazy getter to avoid eagerly initializing at module load time
export function getConversationIndexingJob(): ConversationIndexingJob {
    return ConversationIndexingJob.getInstance();
}
