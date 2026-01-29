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
import { conversationEmbeddingService } from "./ConversationEmbeddingService";
import { IndexingStateManager } from "./IndexingStateManager";
import { listProjectIdsFromDisk, listConversationIdsFromDiskForProject } from "@/conversations/ConversationDiskReader";

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
     * Run a single indexing batch
     * This identifies conversations that need indexing and processes them
     */
    private async runIndexingBatch(): Promise<void> {
        // Prevent overlapping batches
        if (this.isBatchRunning) {
            logger.warn("Skipping indexing batch - previous batch still running");
            return;
        }

        this.isBatchRunning = true;
        logger.debug("Running conversation indexing batch");

        try {
            // Ensure the embedding service is initialized
            await conversationEmbeddingService.initialize();

            let totalIndexed = 0;
            let totalChecked = 0;
            let totalSkipped = 0;
            let totalFailed = 0;

            // Get all projects directly from disk
            const projectIds = listProjectIdsFromDisk(this.projectsBasePath);

            for (const projectId of projectIds) {
                const { indexed, checked, skipped, failed } = await this.indexProjectConversations(
                    projectId
                );
                totalIndexed += indexed;
                totalChecked += checked;
                totalSkipped += skipped;
                totalFailed += failed;
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
     * Index conversations for a single project
     * Returns accurate metrics for indexed, skipped, and failed conversations
     */
    private async indexProjectConversations(projectId: string): Promise<{
        indexed: number;
        checked: number;
        skipped: number;
        failed: number;
    }> {
        let indexed = 0;
        let checked = 0;
        let skipped = 0;
        let failed = 0;

        try {
            // Read conversations directly from disk
            const conversationIds = listConversationIdsFromDiskForProject(
                this.projectsBasePath,
                projectId
            );

            for (const conversationId of conversationIds) {
                checked++;

                // Check if conversation needs indexing using durable state
                const needsIndexing = this.stateManager.needsIndexing(
                    this.projectsBasePath,
                    projectId,
                    conversationId
                );

                if (!needsIndexing) {
                    skipped++;
                    continue;
                }

                // Try to index the conversation
                try {
                    const success = await conversationEmbeddingService.indexConversation(
                        conversationId,
                        projectId
                    );

                    if (success) {
                        indexed++;
                        // Mark as indexed in durable state
                        this.stateManager.markIndexed(this.projectsBasePath, projectId, conversationId);
                    } else {
                        // indexConversation returns false for empty/missing content
                        failed++;
                    }
                } catch (error) {
                    failed++;
                    logger.error("Failed to index conversation", {
                        conversationId: conversationId.substring(0, 8),
                        projectId,
                        error,
                    });
                }
            }

            if (indexed > 0) {
                logger.debug(
                    `Project ${projectId}: indexed ${indexed}, skipped ${skipped}, failed ${failed} (checked ${checked})`
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("Failed to index project conversations", {
                projectId,
                error: message,
            });
        }

        return { indexed, checked, skipped, failed };
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

// Export singleton getter for convenience
export const conversationIndexingJob = ConversationIndexingJob.getInstance();
