/**
 * PrefixKVStore - Centralized prefix-to-full-ID lookup store
 *
 * Provides O(1) lookups of event IDs and pubkeys by their 10-character hex prefix.
 * Uses LMDB for fast, persistent storage.
 *
 * Storage location: ~/.tenex/data/prefix-kv/
 *
 * Key format: 10-char prefix -> 64-char full ID (internal storage format; see STORAGE_PREFIX_LENGTH note below)
 * Collision policy: First write wins (collisions are statistically irrelevant)
 *
 * LIFECYCLE: This store is GLOBAL across all projects and uses reference counting.
 * - Each call to initialize() increments the reference count
 * - Each call to close() decrements the reference count (does NOT close the DB)
 * - The DB remains open as long as at least one reference exists
 * - Use forceClose() only during full daemon shutdown to actually close the DB
 *
 * Per-project runtimes SHOULD call:
 * - initialize() during startup (increments refcount)
 * - close() during shutdown (decrements refcount, keeps DB open for other runtimes)
 *
 * Migration scripts SHOULD call:
 * - initialize() at start
 * - forceClose() at end (since they run standalone, not within the daemon)
 *
 * CONCURRENCY NOTE: The first-write-wins policy uses check-then-put which is
 * not strictly atomic under concurrent writers. In practice, this is acceptable
 * because prefix collisions are extremely rare (1 in 2^40 ≈ 1.1 trillion for random IDs), and
 * the worst case is that a later ID wins over an earlier one for the same prefix.
 *
 * COLLISION PROBABILITY: With 10 hex characters (40 bits of entropy), the probability of
 * collision follows the birthday paradox. For N items, collision probability ≈ N²/(2×2^40).
 * Examples: 1M items = 0.05%, 10M items = 4.5%, 100M items = ~100% collision expected.
 * For typical TENEX workloads (1K-100K conversations), collision risk is negligible.
 */

import { open, type RootDatabase } from "lmdb";
import { join } from "node:path";
import { getTenexBasePath } from "@/constants";
import { logger } from "@/utils/logger";

// NOTE: This STORAGE_PREFIX_LENGTH is intentionally separate from the display STORAGE_PREFIX_LENGTH in
// nostr-entity-parser.ts. This value defines the LMDB storage key format used for
// event ID and pubkey lookups (10-char hex prefix → 64-char full ID). Changing this
// would invalidate the existing on-disk LMDB database and require a migration.
// The display truncation length (for UI/tool output) is controlled by STORAGE_PREFIX_LENGTH
// in src/utils/nostr-entity-parser.ts.
//
// PREFIX LENGTH RATIONALE: 10 hex chars = 40 bits of entropy = 2^40 ≈ 1.1 trillion unique values.
// Birthday paradox collision probability for N items: N²/(2×2^40). Typical workloads (1K-100K
// conversations) have negligible collision risk (<0.001% for 100K items).
const STORAGE_PREFIX_LENGTH = 10;
const FULL_ID_LENGTH = 64;

export class PrefixKVStore {
    private static instance: PrefixKVStore | null = null;
    private db: RootDatabase<string, string> | null = null;
    private initialized = false;
    private initializationPromise: Promise<void> | null = null;
    private referenceCount = 0;

    private constructor() {}

    static getInstance(): PrefixKVStore {
        if (!PrefixKVStore.instance) {
            PrefixKVStore.instance = new PrefixKVStore();
        }
        return PrefixKVStore.instance;
    }

    /**
     * Initialize the LMDB store.
     * Thread-safe: concurrent calls share a single initialization.
     * Must be called before any operations.
     */
    async initialize(): Promise<void> {
        // Fast path: already initialized
        if (this.initialized) {
            this.referenceCount++;
            return;
        }

        // Concurrency guard: if initialization is in progress, wait for it
        if (this.initializationPromise) {
            await this.initializationPromise;
            this.referenceCount++;
            return;
        }

        // Start initialization
        this.initializationPromise = this.doInitialize();

        try {
            await this.initializationPromise;
            this.referenceCount++;
        } finally {
            // Clear the promise after completion (success or failure)
            this.initializationPromise = null;
        }
    }

    /**
     * Internal initialization logic.
     */
    private async doInitialize(): Promise<void> {
        const dataPath = join(getTenexBasePath(), "data", "prefix-kv");

        try {
            this.db = open<string, string>({
                path: dataPath,
                compression: false,
                encoding: "string",
            });
            this.initialized = true;
            logger.debug(`[PrefixKVStore] Initialized at ${dataPath}`);
        } catch (error) {
            logger.error("[PrefixKVStore] Failed to initialize LMDB", {
                error: error instanceof Error ? error.message : String(error),
                path: dataPath,
            });
            throw error;
        }
    }

    /**
     * Add an ID (event ID or pubkey) to the store.
     * Extracts the 10-char prefix and stores the mapping.
     * First write wins - if prefix already exists, this is a no-op.
     */
    async add(fullId: string): Promise<void> {
        if (!this.db) {
            throw new Error("[PrefixKVStore] Not initialized. Call initialize() first.");
        }

        if (!fullId || fullId.length !== FULL_ID_LENGTH) {
            return; // Silently ignore invalid IDs
        }

        const prefix = fullId.substring(0, STORAGE_PREFIX_LENGTH);

        // First write wins - only add if not exists
        const existing = this.db.get(prefix);
        if (existing) {
            return;
        }

        await this.db.put(prefix, fullId);
    }

    /**
     * Add multiple IDs in a batch operation.
     * More efficient than calling add() multiple times.
     */
    async addBatch(fullIds: string[]): Promise<void> {
        const db = this.db;
        if (!db) {
            throw new Error("[PrefixKVStore] Not initialized. Call initialize() first.");
        }

        const validIds = fullIds.filter((id) => id && id.length === FULL_ID_LENGTH);
        if (validIds.length === 0) return;

        await db.batch(() => {
            for (const fullId of validIds) {
                const prefix = fullId.substring(0, STORAGE_PREFIX_LENGTH);
                const existing = db.get(prefix);
                if (!existing) {
                    db.put(prefix, fullId);
                }
            }
        });
    }

    /**
     * Look up a full ID by its prefix.
     * Returns the full 64-char ID or null if not found.
     *
     * @param prefix - Must be exactly 10 hex characters. Returns null otherwise.
     */
    lookup(prefix: string): string | null {
        if (!this.db) {
            throw new Error("[PrefixKVStore] Not initialized. Call initialize() first.");
        }

        // Require exactly 10 characters - no padding or truncation
        // This prevents confusing behavior where short prefixes would
        // be zero-padded and almost never match anything
        if (!prefix || prefix.length !== STORAGE_PREFIX_LENGTH) {
            return null;
        }

        const result = this.db.get(prefix);
        return result ?? null;
    }

    /**
     * Check if a prefix exists in the store.
     */
    has(prefix: string): boolean {
        return this.lookup(prefix) !== null;
    }

    /**
     * Get statistics about the store.
     */
    async getStats(): Promise<{ count: number }> {
        if (!this.db) {
            throw new Error("[PrefixKVStore] Not initialized. Call initialize() first.");
        }

        let count = 0;
        for (const _entry of this.db.getRange()) {
            count++;
        }

        return { count };
    }

    /**
     * Release a reference to the store.
     * For per-project runtimes - decrements reference count but does NOT close the store.
     * Use forceClose() for daemon shutdown.
     */
    async close(): Promise<void> {
        if (this.referenceCount > 0) {
            this.referenceCount--;
            logger.debug(`[PrefixKVStore] Reference released, remaining: ${this.referenceCount}`);
        }
        // Note: We intentionally do NOT close the DB here.
        // Per-project runtimes call this on stop, but the store should
        // remain open for other active runtimes.
    }

    /**
     * Force close the database connection.
     * Should ONLY be called during full daemon shutdown, not per-project stop.
     */
    async forceClose(): Promise<void> {
        if (this.db) {
            await this.db.close();
            this.db = null;
            this.initialized = false;
            this.referenceCount = 0;
            logger.debug("[PrefixKVStore] Force closed");
        }
    }

    /**
     * Check if the store is initialized.
     */
    isInitialized(): boolean {
        return this.initialized;
    }
}

// Export singleton instance
export const prefixKVStore = PrefixKVStore.getInstance();
