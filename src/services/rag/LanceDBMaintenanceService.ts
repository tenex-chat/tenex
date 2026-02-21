/**
 * LanceDBMaintenanceService - Periodic compaction and cleanup
 *
 * Runs optimize() on all LanceDB tables to:
 * - Compact small fragment files into larger ones
 * - Prune old version manifests
 *
 * This prevents fragmentation accumulation from frequent writes.
 * Uses a self-scheduling setTimeout pattern (like ConversationIndexingJob)
 * to prevent overlapping runs.
 */

import { logger } from "@/utils/logger";
import { RAGDatabaseService } from "./RAGDatabaseService";

/** Default interval: 2 hours (in milliseconds) */
const DEFAULT_INTERVAL_MS = 2 * 60 * 60 * 1000;

/**
 * Cleanup versions older than this duration.
 * We keep 1 day of history for safety; the current version is never removed.
 */
const DEFAULT_CLEANUP_OLDER_THAN_DAYS = 1;

/**
 * Periodic LanceDB maintenance service
 */
export class LanceDBMaintenanceService {
    private static instance: LanceDBMaintenanceService | null = null;
    private timer: NodeJS.Timeout | null = null;
    private isRunning = false;
    private isMaintenanceRunning = false;
    private intervalMs: number;

    private constructor(intervalMs: number = DEFAULT_INTERVAL_MS) {
        this.intervalMs = intervalMs;
    }

    /**
     * Get singleton instance
     */
    public static getInstance(intervalMs?: number): LanceDBMaintenanceService {
        if (!LanceDBMaintenanceService.instance) {
            LanceDBMaintenanceService.instance = new LanceDBMaintenanceService(intervalMs);
        }
        return LanceDBMaintenanceService.instance;
    }

    /**
     * Start the periodic maintenance job
     */
    public start(): void {
        if (this.isRunning) {
            logger.warn("LanceDBMaintenanceService is already running");
            return;
        }

        this.isRunning = true;
        logger.info("Starting LanceDBMaintenanceService", {
            intervalMs: this.intervalMs,
            intervalHours: this.intervalMs / (60 * 60 * 1000),
        });

        // Run first maintenance after a short delay (30 seconds)
        // to let the system finish booting
        this.scheduleNextRun(30_000);
    }

    /**
     * Schedule the next maintenance run (self-scheduling to prevent overlaps)
     */
    private scheduleNextRun(delayMs: number): void {
        if (!this.isRunning) return;

        this.timer = setTimeout(async () => {
            try {
                await this.runMaintenance();
            } catch (error) {
                logger.error("LanceDB maintenance failed", { error });
            } finally {
                // Schedule next run only after this one completes
                this.scheduleNextRun(this.intervalMs);
            }
        }, delayMs);
    }

    /**
     * Stop the periodic maintenance job
     */
    public stop(): void {
        if (!this.isRunning) {
            return;
        }

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        this.isRunning = false;
        logger.info("LanceDBMaintenanceService stopped");
    }

    /**
     * Run maintenance on all LanceDB tables
     */
    private async runMaintenance(): Promise<void> {
        if (this.isMaintenanceRunning) {
            logger.warn("Skipping LanceDB maintenance - previous run still in progress");
            return;
        }

        this.isMaintenanceRunning = true;

        // Use a temporary DB service to avoid coupling to RAGService singleton
        // (which requires embedding provider initialization)
        let dbService: RAGDatabaseService | null = null;

        try {
            dbService = new RAGDatabaseService();
            const tableNames = await dbService.listTables();

            if (tableNames.length === 0) {
                logger.debug("No LanceDB tables to optimize");
                return;
            }

            logger.info("Starting LanceDB maintenance", { tableCount: tableNames.length });

            const cleanupOlderThan = new Date();
            cleanupOlderThan.setDate(cleanupOlderThan.getDate() - DEFAULT_CLEANUP_OLDER_THAN_DAYS);

            let optimizedCount = 0;

            for (const tableName of tableNames) {
                try {
                    const table = await dbService.getTable(tableName);
                    const stats = await table.optimize({
                        cleanupOlderThan,
                    });

                    optimizedCount++;
                    logger.info(`Optimized table '${tableName}'`, {
                        compaction: stats.compaction,
                        prune: stats.prune,
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.error(`Failed to optimize table '${tableName}'`, {
                        error: message,
                    });
                    // Continue with other tables
                }
            }

            logger.info("LanceDB maintenance complete", {
                tablesOptimized: optimizedCount,
                totalTables: tableNames.length,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("LanceDB maintenance failed", { error: message });
        } finally {
            if (dbService) {
                try {
                    await dbService.close();
                } catch (closeError) {
                    logger.debug("Failed to close maintenance DB service", { error: closeError });
                }
            }
            this.isMaintenanceRunning = false;
        }
    }

    /**
     * Force an immediate maintenance run (for manual triggering)
     */
    public async forceRun(): Promise<void> {
        await this.runMaintenance();
    }

    /**
     * Get current service status
     */
    public getStatus(): {
        isRunning: boolean;
        isMaintenanceRunning: boolean;
        intervalMs: number;
    } {
        return {
            isRunning: this.isRunning,
            isMaintenanceRunning: this.isMaintenanceRunning,
            intervalMs: this.intervalMs,
        };
    }

    /**
     * Reset singleton instance (for testing)
     */
    public static resetInstance(): void {
        if (LanceDBMaintenanceService.instance) {
            LanceDBMaintenanceService.instance.stop();
            LanceDBMaintenanceService.instance = null;
        }
    }
}

// Export lazy getter
export function getLanceDBMaintenanceService(): LanceDBMaintenanceService {
    return LanceDBMaintenanceService.getInstance();
}
