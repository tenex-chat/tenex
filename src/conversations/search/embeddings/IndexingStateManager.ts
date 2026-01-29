/**
 * IndexingStateManager - Durable per-conversation indexing state
 *
 * This manager tracks the indexing state of conversations to determine when
 * they need to be re-indexed. It uses a hash-based approach to detect changes
 * in conversation metadata (title, summary, last_user_message, lastActivity).
 *
 * Key features:
 * - Durable state: persisted to disk in a KV store
 * - Detects metadata changes via hash comparison
 * - Bounded memory: only loads state for active projects
 * - No unbounded growth: old entries naturally expire
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { logger } from "@/utils/logger";
import { readLightweightMetadata } from "@/conversations/ConversationDiskReader";

/**
 * State for a single conversation
 */
interface ConversationIndexState {
    /** Hash of indexed metadata */
    metadataHash: string;
    /** Timestamp of last indexing */
    lastIndexedAt: number;
    /** Last known activity timestamp */
    lastActivity?: number;
}

/**
 * State file structure
 */
interface StateFile {
    version: number;
    states: Record<string, ConversationIndexState>; // Key: "projectId:conversationId"
}

/**
 * Manager for conversation indexing state with LRU eviction
 */
export class IndexingStateManager {
    private static readonly STATE_VERSION = 1;
    private static readonly MAX_ENTRIES = 10000; // Prevent unbounded growth
    private static readonly EVICTION_BATCH_SIZE = 1000; // Remove oldest 10% when full

    private stateFilePath: string;
    private states: Map<string, ConversationIndexState> = new Map();
    private dirty = false;
    private saveTimer: NodeJS.Timeout | null = null;

    constructor(baseDir: string) {
        // Store state file in the projects directory
        this.stateFilePath = join(baseDir, "indexing-state.json");
        this.loadState();
    }

    /**
     * Load state from disk
     */
    private loadState(): void {
        try {
            if (!existsSync(this.stateFilePath)) {
                logger.debug("No indexing state file found, starting fresh");
                return;
            }

            const content = readFileSync(this.stateFilePath, "utf-8");
            const stateFile: StateFile = JSON.parse(content);

            if (stateFile.version !== IndexingStateManager.STATE_VERSION) {
                logger.warn("Indexing state version mismatch, resetting state");
                return;
            }

            // Load into map
            for (const [key, value] of Object.entries(stateFile.states)) {
                this.states.set(key, value);
            }

            logger.info(`Loaded indexing state: ${this.states.size} entries`);
        } catch (error) {
            logger.error("Failed to load indexing state, starting fresh", { error });
            this.states.clear();
        }
    }

    /**
     * Save state to disk (debounced)
     */
    private scheduleSave(): void {
        if (!this.dirty) {
            this.dirty = true;
        }

        // Clear existing timer
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }

        // Schedule save in 5 seconds
        this.saveTimer = setTimeout(() => {
            this.saveNow();
        }, 5000);
    }

    /**
     * Immediately save state to disk
     */
    public saveNow(): void {
        if (!this.dirty) return;

        try {
            // Ensure directory exists
            const dir = join(this.stateFilePath, "..");
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }

            // Evict old entries if needed
            if (this.states.size > IndexingStateManager.MAX_ENTRIES) {
                this.evictOldEntries();
            }

            // Convert map to object
            const statesObj: Record<string, ConversationIndexState> = {};
            for (const [key, value] of this.states.entries()) {
                statesObj[key] = value;
            }

            const stateFile: StateFile = {
                version: IndexingStateManager.STATE_VERSION,
                states: statesObj,
            };

            writeFileSync(this.stateFilePath, JSON.stringify(stateFile, null, 2), "utf-8");
            this.dirty = false;

            logger.debug(`Saved indexing state: ${this.states.size} entries`);
        } catch (error) {
            logger.error("Failed to save indexing state", { error });
        }
    }

    /**
     * Evict oldest entries when reaching max size
     */
    private evictOldEntries(): void {
        // Sort by lastIndexedAt
        const entries = Array.from(this.states.entries()).sort(
            (a, b) => a[1].lastIndexedAt - b[1].lastIndexedAt
        );

        // Remove oldest batch
        const toRemove = entries.slice(0, IndexingStateManager.EVICTION_BATCH_SIZE);
        for (const [key] of toRemove) {
            this.states.delete(key);
        }

        logger.info(
            `Evicted ${toRemove.length} old indexing state entries (max: ${IndexingStateManager.MAX_ENTRIES})`
        );
    }

    /**
     * Build a composite key for state lookup
     */
    private buildKey(projectId: string, conversationId: string): string {
        return `${projectId}:${conversationId}`;
    }

    /**
     * Calculate metadata hash for a conversation
     * Hash includes: title, summary, last_user_message, lastActivity
     */
    private calculateMetadataHash(
        basePath: string,
        projectId: string,
        conversationId: string
    ): string | null {
        try {
            const metadata = readLightweightMetadata(basePath, projectId, conversationId);
            if (!metadata) return null;

            // Build a stable string representation
            const parts: string[] = [
                metadata.metadata.title || "",
                metadata.metadata.summary || "",
                metadata.metadata.last_user_message || "",
                String(metadata.metadata.lastActivity || 0),
            ];

            const hashInput = parts.join("|");
            return createHash("sha256").update(hashInput).digest("hex");
        } catch (error) {
            logger.debug(`Failed to calculate metadata hash for ${conversationId.substring(0, 8)}`, {
                error,
            });
            return null;
        }
    }

    /**
     * Check if a conversation needs indexing
     * Returns true if:
     * - Never indexed before
     * - Metadata has changed (different hash)
     * - Activity timestamp advanced
     */
    public needsIndexing(
        basePath: string,
        projectId: string,
        conversationId: string
    ): boolean {
        const key = this.buildKey(projectId, conversationId);
        const currentState = this.states.get(key);

        // Calculate current metadata hash
        const currentHash = this.calculateMetadataHash(basePath, projectId, conversationId);
        if (!currentHash) {
            // Can't read metadata - skip
            return false;
        }

        // Never indexed before
        if (!currentState) {
            return true;
        }

        // Metadata changed
        if (currentState.metadataHash !== currentHash) {
            return true;
        }

        // Check if activity advanced
        const metadata = readLightweightMetadata(basePath, projectId, conversationId);
        if (metadata?.metadata.lastActivity) {
            const currentActivity = metadata.metadata.lastActivity;
            const lastActivity = currentState.lastActivity || 0;

            if (currentActivity > lastActivity) {
                return true;
            }
        }

        // Already indexed and unchanged
        return false;
    }

    /**
     * Mark a conversation as indexed
     */
    public markIndexed(basePath: string, projectId: string, conversationId: string): void {
        const key = this.buildKey(projectId, conversationId);
        const hash = this.calculateMetadataHash(basePath, projectId, conversationId);

        if (!hash) {
            logger.debug(`Cannot mark ${conversationId.substring(0, 8)} as indexed - no metadata`);
            return;
        }

        // Get current activity timestamp
        const metadata = readLightweightMetadata(basePath, projectId, conversationId);
        const lastActivity = metadata?.metadata.lastActivity;

        this.states.set(key, {
            metadataHash: hash,
            lastIndexedAt: Date.now(),
            lastActivity,
        });

        this.scheduleSave();
    }

    /**
     * Clear a conversation's indexing state (forces re-index)
     */
    public clearState(projectId: string, conversationId: string): void {
        const key = this.buildKey(projectId, conversationId);
        this.states.delete(key);
        this.scheduleSave();
    }

    /**
     * Clear all state (forces full re-index)
     */
    public clearAllState(): void {
        this.states.clear();
        this.scheduleSave();
    }

    /**
     * Get statistics about the state
     */
    public getStats(): {
        totalEntries: number;
        maxEntries: number;
        isDirty: boolean;
    } {
        return {
            totalEntries: this.states.size,
            maxEntries: IndexingStateManager.MAX_ENTRIES,
            isDirty: this.dirty,
        };
    }

    /**
     * Cleanup and save before shutdown
     */
    public dispose(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        this.saveNow();
    }
}
