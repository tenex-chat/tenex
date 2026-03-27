/**
 * ActiveRalIndex - Lightweight index of conversations with active RALs.
 *
 * Maintains a single JSON file per project listing conversation IDs that
 * currently have active RALs. This avoids scanning thousands of conversation
 * files at startup just to find the few with orphaned RALs.
 *
 * File location: ~/.tenex/projects/{projectId}/active-rals.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { logger } from "@/utils/logger";

/**
 * Singleton per-project index of conversations with active RALs.
 * Keyed by project metadata base path.
 */
const instances = new Map<string, ActiveRalIndex>();

export class ActiveRalIndex {
    private filePath: string;
    private conversationIds: Set<string>;

    private constructor(projectMetadataPath: string) {
        this.filePath = join(projectMetadataPath, "active-rals.json");
        this.conversationIds = this.loadFromDisk();
    }

    static getInstance(projectMetadataPath: string): ActiveRalIndex {
        let instance = instances.get(projectMetadataPath);
        if (!instance) {
            instance = new ActiveRalIndex(projectMetadataPath);
            instances.set(projectMetadataPath, instance);
        }
        return instance;
    }

    static resetInstance(projectMetadataPath: string): void {
        instances.delete(projectMetadataPath);
    }

    /**
     * Get all conversation IDs that have active RALs.
     */
    getConversationIds(): string[] {
        return Array.from(this.conversationIds);
    }

    /**
     * Mark a conversation as having an active RAL.
     */
    add(conversationId: string): void {
        if (this.conversationIds.has(conversationId)) return;
        this.conversationIds.add(conversationId);
        this.persist();
    }

    /**
     * Remove a conversation from the index (no more active RALs).
     */
    remove(conversationId: string): void {
        if (!this.conversationIds.has(conversationId)) return;
        this.conversationIds.delete(conversationId);
        this.persist();
    }

    private loadFromDisk(): Set<string> {
        try {
            if (existsSync(this.filePath)) {
                const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
                if (Array.isArray(data)) {
                    return new Set(data);
                }
            }
        } catch (error) {
            logger.warn("[ActiveRalIndex] Failed to load index, starting fresh", {
                path: this.filePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return new Set();
    }

    private persist(): void {
        try {
            const dir = dirname(this.filePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            writeFileSync(this.filePath, JSON.stringify(Array.from(this.conversationIds)));
        } catch (error) {
            logger.warn("[ActiveRalIndex] Failed to persist index", {
                path: this.filePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}
