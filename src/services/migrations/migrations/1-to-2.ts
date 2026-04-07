import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTenexBasePath } from "@/constants";
import { directoryExists } from "@/lib/fs";
import { prefixKVStore } from "@/services/storage";
import { ConversationCatalogService } from "@/conversations/ConversationCatalogService";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { createProjectDTag } from "@/types/project-ids";
import type { MigrationRunResult, StateMigration } from "../types";

export const migration1To2: StateMigration = {
    from: 1,
    to: 2,
    description: "Reindex PrefixKVStore from 18-char to 10-char prefixes",
    run: migrate1To2,
};

async function migrate1To2(): Promise<MigrationRunResult> {
    const warnings: string[] = [];
    let migratedCount = 0;
    let skippedCount = 0;

    const prefixKvPath = path.join(getTenexBasePath(), "data", "prefix-kv");
    const backupPath = path.join(getTenexBasePath(), "data", "prefix-kv.backup");

    // Check if prefix-kv exists
    if (!(await directoryExists(prefixKvPath))) {
        logger.info("[Migration 1→2] No prefix-kv store found, skipping migration");
        return { migratedCount: 0, skippedCount: 0, warnings: [] };
    }

    try {
        // 1. Close the current prefix-kv store if open
        await prefixKVStore.forceClose();

        // 2. Backup existing database
        logger.info("[Migration 1→2] Backing up prefix-kv database");
        await fs.mkdir(backupPath, { recursive: true });

        const files = await fs.readdir(prefixKvPath);
        for (const file of files) {
            const srcPath = path.join(prefixKvPath, file);
            const dstPath = path.join(backupPath, file);
            await fs.copyFile(srcPath, dstPath);
        }

        // 3. Delete old database
        logger.info("[Migration 1→2] Clearing old prefix-kv database");
        for (const file of files) {
            await fs.unlink(path.join(prefixKvPath, file));
        }

        // 4. Reinitialize with new 10-char prefix format
        await prefixKVStore.initialize();

        // 5. Get all conversation IDs from all projects and reindex
        logger.info("[Migration 1→2] Reindexing conversation IDs");
        const projectsMetadataPath = config.getConfigPath("projects");

        if (await directoryExists(projectsMetadataPath)) {
            const projectDirs = await fs.readdir(projectsMetadataPath);
            const conversationIds = new Set<string>();

            for (const projectId of projectDirs) {
                try {
                    const catalogService = ConversationCatalogService.getInstance(
                        createProjectDTag(projectId)
                    );
                    catalogService.initialize();

                    const conversations = catalogService.listConversations({ limit: 100000 });
                    for (const conv of conversations) {
                        conversationIds.add(conv.id);
                    }
                } catch (error) {
                    warnings.push(
                        `Failed to load conversations from project ${projectId.substring(0, 12)}: ${
                            error instanceof Error ? error.message : String(error)
                        }`
                    );
                    skippedCount++;
                }
            }

            // Batch add all conversation IDs (valid 64-char hex IDs only)
            const validIds = Array.from(conversationIds).filter(
                (id) => id.length === 64 && /^[0-9a-f]+$/i.test(id)
            );

            if (validIds.length > 0) {
                await prefixKVStore.addBatch(validIds);
                migratedCount = validIds.length;
                logger.info("[Migration 1→2] Reindexed conversation IDs", {
                    count: validIds.length,
                });
            }
        }

        logger.info("[Migration 1→2] Migration completed", {
            migratedCount,
            skippedCount,
            warnings: warnings.length,
        });

        return {
            migratedCount,
            skippedCount,
            warnings,
        };
    } catch (error) {
        logger.error("[Migration 1→2] Migration failed", {
            error: error instanceof Error ? error.message : String(error),
        });

        // Attempt to restore from backup
        logger.info("[Migration 1→2] Attempting to restore from backup");
        try {
            await prefixKVStore.forceClose();

            const files = await fs.readdir(backupPath);
            for (const file of files) {
                const srcPath = path.join(backupPath, file);
                const dstPath = path.join(prefixKvPath, file);
                await fs.copyFile(srcPath, dstPath);
            }

            logger.info("[Migration 1→2] Restored from backup successfully");
        } catch (restoreError) {
            logger.error("[Migration 1→2] Failed to restore from backup", {
                error: restoreError instanceof Error ? restoreError.message : String(restoreError),
            });
        }

        throw error;
    }
}
