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
 * - Errors propagate to scheduleNextBatch which catches and reschedules
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

/** Default interval: 5 minutes (in milliseconds) */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const INDEXING_FLUSH_DOCUMENT_LIMIT = readPositiveIntegerEnv(
    "TENEX_CONVERSATION_INDEXING_FLUSH_DOCUMENT_LIMIT",
    50
);
const INDEXING_MAX_DOCUMENTS_PER_BATCH = readPositiveIntegerEnv(
    "TENEX_CONVERSATION_INDEXING_MAX_DOCUMENTS_PER_BATCH",
    400
);
const INDEXING_FLUSH_PAUSE_MS = readNonNegativeIntegerEnv(
    "TENEX_CONVERSATION_INDEXING_FLUSH_PAUSE_MS",
    0
);

function readPositiveIntegerEnv(name: string, fallback: number): number {
    const value = process.env[name];
    if (!value) {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntegerEnv(name: string, fallback: number): number {
    const value = process.env[name];
    if (!value) {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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

        // Defer first batch to avoid loading the vector store + embedding model during
        // the startup burst. Concurrent heavy allocations cause JSC to
        // pre-allocate massive memory pools that are never released.
        this.scheduleNextBatch(this.intervalMs);
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
     * Walks conversations needing re-indexing across all projects, builds
     * RAGDocuments for each, then flushes them in bounded batches via bulkUpsert.
     * This keeps v3 transcript backfills from retaining every chunk in memory.
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
            let totalIndexed = 0;
            let totalDocumentsScheduled = 0;
            let projectsVisited = 0;
            let budgetExhausted = false;
            const startedAt = Date.now();
            const batchId = startedAt.toString(36);

            const ragService = RAGService.getInstance();
            const collectionName = conversationEmbeddingService.getCollectionName();

            let pendingDocuments: RAGDocument[] = [];
            let pendingMarkIndexed: Array<{
                projectId: ProjectDTag;
                conversationId: string;
                documentIndices: number[];
                documentIds: string[];
            }> = [];
            const pendingMarkNoContent: Array<{ projectId: ProjectDTag; conversationId: string }> = [];

            const flushPendingDocuments = async (): Promise<void> => {
                if (pendingDocuments.length === 0) {
                    return;
                }

                logger.info("Flushing conversation embedding documents", {
                    batchId,
                    documentCount: pendingDocuments.length,
                    conversationCount: pendingMarkIndexed.length,
                    collectionName,
                    documentsScheduled: totalDocumentsScheduled,
                    maxDocumentsPerBatch: INDEXING_MAX_DOCUMENTS_PER_BATCH,
                });

                const { upsertedCount, failedIndices } = await ragService.bulkUpsert(
                    collectionName,
                    pendingDocuments
                );

                totalIndexed += upsertedCount;

                const failedSet = new Set(failedIndices);
                totalFailed += failedIndices.length;

                // Mark only conversations whose chunks all flushed successfully.
                for (const pendingConversation of pendingMarkIndexed) {
                    if (pendingConversation.documentIndices.some((index) => failedSet.has(index))) {
                        // At least one chunk failed — leave unmarked for retry.
                        continue;
                    }

                    const previousDocumentIds = this.stateManager.getIndexedDocumentIds(
                        pendingConversation.projectId,
                        pendingConversation.conversationId
                    );
                    await this.deleteStaleConversationDocuments(
                        collectionName,
                        previousDocumentIds,
                        pendingConversation.documentIds,
                        ragService
                    );

                    this.stateManager.markIndexed(
                        this.projectsBasePath,
                        pendingConversation.projectId,
                        pendingConversation.conversationId,
                        false,
                        pendingConversation.documentIds
                    );
                }

                pendingDocuments = [];
                pendingMarkIndexed = [];

                logger.info("Conversation embedding document flush complete", {
                    batchId,
                    upsertedCount,
                    failedCount: failedIndices.length,
                    totalIndexed,
                    totalFailed,
                    elapsedMs: Date.now() - startedAt,
                });

                if (INDEXING_FLUSH_PAUSE_MS > 0) {
                    await sleep(INDEXING_FLUSH_PAUSE_MS);
                }
            };

            // Get all projects directly from disk
            const projectIds = listProjectIdsFromDisk(this.projectsBasePath);

            logger.info("Conversation indexing batch started", {
                batchId,
                projectCount: projectIds.length,
                flushDocumentLimit: INDEXING_FLUSH_DOCUMENT_LIMIT,
                maxDocumentsPerBatch: INDEXING_MAX_DOCUMENTS_PER_BATCH,
                flushPauseMs: INDEXING_FLUSH_PAUSE_MS,
            });

            projectLoop:
            for (const projectId of projectIds) {
                projectsVisited++;
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
                            {
                                if (
                                    pendingDocuments.length > 0 &&
                                    pendingDocuments.length + result.documents.length > INDEXING_FLUSH_DOCUMENT_LIMIT
                                ) {
                                    await flushPendingDocuments();
                                }

                                const firstIndex = pendingDocuments.length;
                                pendingDocuments.push(...result.documents);
                                totalDocumentsScheduled += result.documents.length;
                                pendingMarkIndexed.push({
                                    projectId,
                                    conversationId,
                                    documentIndices: result.documents.map((_, offset) => firstIndex + offset),
                                    documentIds: result.documents
                                        .map((document) => document.id)
                                        .filter((id): id is string => typeof id === "string"),
                                });

                                if (pendingDocuments.length >= INDEXING_FLUSH_DOCUMENT_LIMIT) {
                                    await flushPendingDocuments();
                                }

                                if (totalDocumentsScheduled >= INDEXING_MAX_DOCUMENTS_PER_BATCH) {
                                    budgetExhausted = true;
                                    logger.info("Conversation indexing batch document budget reached", {
                                        batchId,
                                        maxDocumentsPerBatch: INDEXING_MAX_DOCUMENTS_PER_BATCH,
                                        documentsScheduled: totalDocumentsScheduled,
                                        conversationsChecked: totalChecked,
                                        projectId,
                                        conversationId: conversationId.substring(0, 8),
                                    });
                                    break projectLoop;
                                }
                            }
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

            // Flush any tail documents via bulkUpsert (per-chunk failure isolation).
            await flushPendingDocuments();

            // Mark no-content conversations to avoid re-trying every batch
            for (const { projectId, conversationId } of pendingMarkNoContent) {
                this.stateManager.markIndexed(
                    this.projectsBasePath,
                    projectId,
                    conversationId,
                    true,
                    []
                );
            }

            if (totalChecked > 0) {
                logger.info("Conversation indexing batch complete", {
                    batchId,
                    projectsProcessed: projectsVisited,
                    totalProjects: projectIds.length,
                    conversationsChecked: totalChecked,
                    documentsScheduled: totalDocumentsScheduled,
                    newlyIndexed: totalIndexed,
                    skipped: totalSkipped,
                    failed: totalFailed,
                    budgetExhausted,
                    elapsedMs: Date.now() - startedAt,
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
        await this.runIndexingBatch();
    }

    private async deleteStaleConversationDocuments(
        collectionName: string,
        previousDocumentIds: string[],
        currentDocumentIds: string[],
        ragService: RAGService
    ): Promise<void> {
        const currentSet = new Set(currentDocumentIds);
        const staleDocumentIds = previousDocumentIds.filter((documentId) => !currentSet.has(documentId));

        for (const documentId of staleDocumentIds) {
            try {
                await ragService.deleteDocumentById(collectionName, documentId);
            } catch (error) {
                logger.warn("Failed to delete stale conversation embedding document", {
                    collectionName,
                    documentId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
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
