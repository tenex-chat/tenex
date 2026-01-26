/**
 * ConversationRegistry - Global registry for conversation stores
 *
 * This singleton manages the lifecycle of ConversationStore instances:
 * - Loading and caching conversation stores
 * - Event caching for fast lookup
 * - Project-level initialization
 * - Cross-project conversation discovery
 *
 * The heavy lifting is delegated to individual ConversationStore instances.
 */

import { existsSync, readdirSync } from "fs";
import { basename, dirname, join } from "path";
import { getTenexBasePath } from "@/constants";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";
import type { ConversationMetadata } from "./types";
import {
    listConversationIdsFromDiskForProject,
    listProjectIdsFromDisk,
    readConversationPreviewForProject,
    readLightweightMetadata,
    readMessagesFromDisk,
} from "./ConversationDiskReader";
import {
    getIndexManager,
    parseQuery,
    search as searchIndex,
    type AdvancedSearchResult,
    type RawSearchInput,
} from "./search";

// Forward declaration - ConversationStore will be imported dynamically
// to avoid circular dependencies
let ConversationStoreClass: typeof import("./ConversationStore").ConversationStore;

function getConversationStoreClass() {
    if (!ConversationStoreClass) {
        ConversationStoreClass = require("./ConversationStore").ConversationStore;
    }
    return ConversationStoreClass;
}

/**
 * Singleton registry for managing conversation stores
 */
class ConversationRegistryImpl {
    private stores: Map<string, InstanceType<typeof ConversationStoreClass>> = new Map();
    private eventCache: Map<string, NDKEvent> = new Map();
    private _basePath: string = join(getTenexBasePath(), "projects");
    private _projectId: string | null = null;
    private _agentPubkeys: Set<string> = new Set();

    get basePath(): string {
        return this._basePath;
    }

    get projectId(): string | null {
        return this._projectId;
    }

    get agentPubkeys(): Set<string> {
        return this._agentPubkeys;
    }

    /**
     * Initialize the registry for a project.
     * Must be called once at startup before using any stores.
     */
    initialize(metadataPath: string, agentPubkeys?: Iterable<string>): void {
        this._basePath = dirname(metadataPath);
        this._projectId = basename(metadataPath);
        this._agentPubkeys = new Set(agentPubkeys ?? []);
        logger.info(`[ConversationRegistry] Initialized for project ${this._projectId}`);
    }

    /**
     * Get or load a conversation store by ID.
     * Loads from disk if not already in memory.
     */
    getOrLoad(conversationId: string): InstanceType<typeof ConversationStoreClass> {
        let store = this.stores.get(conversationId);
        if (!store) {
            if (!this._projectId) {
                throw new Error("ConversationRegistry.initialize() must be called before getOrLoad()");
            }
            const StoreClass = getConversationStoreClass();
            store = new StoreClass(this._basePath);
            store.load(this._projectId, conversationId);
            this.stores.set(conversationId, store);
        }
        return store;
    }

    /**
     * Get a conversation store if it exists in memory or on disk.
     * Returns undefined if conversation doesn't exist.
     */
    get(conversationId: string): InstanceType<typeof ConversationStoreClass> | undefined {
        const cached = this.stores.get(conversationId);
        if (cached) return cached;

        // Try current project first
        if (this._projectId) {
            const StoreClass = getConversationStoreClass();
            const store = new StoreClass(this._basePath);
            try {
                store.load(this._projectId, conversationId);
                if (store.getAllMessages().length > 0) {
                    this.stores.set(conversationId, store);
                    return store;
                }
            } catch {
                // Store doesn't exist
            }
        }

        // Search other projects
        const otherProjectId = this.findProjectForConversation(conversationId);
        if (otherProjectId) {
            const StoreClass = getConversationStoreClass();
            const store = new StoreClass(this._basePath);
            try {
                store.load(otherProjectId, conversationId);
                if (store.getAllMessages().length > 0) {
                    this.stores.set(conversationId, store);
                    logger.debug(`[ConversationRegistry] Found conversation ${conversationId.substring(0, 8)} in project ${otherProjectId}`);
                    return store;
                }
            } catch {
                // Store doesn't exist
            }
        }

        return undefined;
    }

    /**
     * Find which project contains a conversation.
     */
    private findProjectForConversation(conversationId: string): string | undefined {
        try {
            if (!existsSync(this._basePath)) return undefined;

            const projectDirs = readdirSync(this._basePath);
            for (const projectDir of projectDirs) {
                if (projectDir === this._projectId) continue;
                if (projectDir === "metadata") continue;

                const conversationFile = join(
                    this._basePath,
                    projectDir,
                    "conversations",
                    `${conversationId}.json`
                );

                if (existsSync(conversationFile)) {
                    return projectDir;
                }
            }
        } catch {
            // Error reading directories
        }
        return undefined;
    }

    /**
     * Check if a conversation exists.
     */
    has(conversationId: string): boolean {
        return this.get(conversationId) !== undefined;
    }

    /**
     * Create a new conversation from an NDKEvent.
     */
    async create(event: NDKEvent): Promise<InstanceType<typeof ConversationStoreClass>> {
        const eventId = event.id;
        if (!eventId) {
            throw new Error("Event must have an ID to create a conversation");
        }

        const existing = this.stores.get(eventId);
        if (existing) {
            logger.debug(`Conversation ${eventId.substring(0, 8)} already exists`);
            return existing;
        }

        if (!this._projectId) {
            throw new Error("ConversationRegistry.initialize() must be called before create()");
        }

        const StoreClass = getConversationStoreClass();
        const store = new StoreClass(this._basePath);
        store.load(this._projectId, eventId);

        const isFromAgent = this._agentPubkeys.has(event.pubkey);
        store.addEventMessage(event, isFromAgent);

        this.eventCache.set(eventId, event);

        if (event.content) {
            store.setTitle(event.content.substring(0, 50) + (event.content.length > 50 ? "..." : ""));
        }

        await store.save();
        this.stores.set(eventId, store);

        logger.info(`Starting conversation ${eventId.substring(0, 8)} - "${event.content?.substring(0, 50)}..."`);

        return store;
    }

    /**
     * Find a conversation by an event ID it contains.
     */
    findByEventId(eventId: string): InstanceType<typeof ConversationStoreClass> | undefined {
        for (const store of this.stores.values()) {
            if (store.hasEventId(eventId)) {
                return store;
            }
        }
        return undefined;
    }

    /**
     * Get all loaded conversation stores.
     */
    getAll(): InstanceType<typeof ConversationStoreClass>[] {
        return Array.from(this.stores.values());
    }

    /**
     * Cache an NDKEvent.
     */
    cacheEvent(event: NDKEvent): void {
        if (event.id) {
            this.eventCache.set(event.id, event);
        }
    }

    /**
     * Get a cached NDKEvent.
     */
    getCachedEvent(eventId: string): NDKEvent | undefined {
        return this.eventCache.get(eventId);
    }

    /**
     * Add an event to a conversation.
     */
    async addEvent(conversationId: string, event: NDKEvent): Promise<void> {
        const store = this.getOrLoad(conversationId);
        const isFromAgent = this._agentPubkeys.has(event.pubkey);
        store.addEventMessage(event, isFromAgent);

        if (event.id) {
            this.eventCache.set(event.id, event);
        }

        await store.save();
    }

    /**
     * Set conversation title.
     */
    setConversationTitle(conversationId: string, title: string): void {
        const store = this.get(conversationId);
        if (store) {
            store.setTitle(title);
        }
    }

    /**
     * Update conversation metadata.
     */
    async updateConversationMetadata(
        conversationId: string,
        metadata: Partial<ConversationMetadata>
    ): Promise<void> {
        const store = this.get(conversationId);
        if (!store) {
            throw new Error(`Conversation ${conversationId} not found`);
        }
        store.updateMetadata(metadata);
        await store.save();
    }

    /**
     * Archive a conversation (remove from memory).
     */
    archive(conversationId: string): void {
        const store = this.stores.get(conversationId);
        if (store) {
            for (const entry of store.getAllMessages()) {
                if (entry.eventId) {
                    this.eventCache.delete(entry.eventId);
                }
            }
        }
        this.stores.delete(conversationId);
    }

    /**
     * Complete a conversation (save and archive).
     */
    async complete(conversationId: string): Promise<void> {
        const store = this.stores.get(conversationId);
        if (store) {
            await store.save();
            for (const entry of store.getAllMessages()) {
                if (entry.eventId) {
                    this.eventCache.delete(entry.eventId);
                }
            }
            this.stores.delete(conversationId);
        }
    }

    /**
     * Save all and clean up.
     */
    async cleanup(): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const store of this.stores.values()) {
            promises.push(store.save());
        }
        await Promise.all(promises);
    }

    /**
     * Search conversations by title (legacy in-memory search).
     * @deprecated Use searchAdvanced for full-text search across all conversations.
     */
    search(query: string): InstanceType<typeof ConversationStoreClass>[] {
        const results: InstanceType<typeof ConversationStoreClass>[] = [];
        const queryLower = query.toLowerCase();
        for (const store of this.stores.values()) {
            const title = store.getTitle();
            if (title && title.toLowerCase().includes(queryLower)) {
                results.push(store);
            }
        }
        return results;
    }

    /**
     * Advanced search across ALL conversations (not just in-memory).
     * Supports full-text search on message content, agent filters, and date filters.
     *
     * @param input - Search input with query text and optional filters
     * @param limit - Maximum number of results (default: 20)
     * @returns AdvancedSearchResult with explicit success/error information
     */
    searchAdvanced(input: RawSearchInput, limit: number = 20): AdvancedSearchResult {
        if (!this._projectId) {
            logger.warn("[ConversationRegistry] searchAdvanced called before initialization");
            return {
                success: false,
                results: [],
                error: "ConversationRegistry not initialized",
            };
        }

        try {
            // Parse and validate the query
            const query = parseQuery(input);

            // Get or create the index manager for this project
            const indexManager = getIndexManager(this._basePath, this._projectId);

            // Get the index (loads from disk or rebuilds if needed)
            const index = indexManager.getIndex();

            // Perform the search
            const results = searchIndex(query, index, limit);

            logger.debug("[ConversationRegistry] Advanced search completed", {
                query: input.query,
                resultCount: results.length,
                projectId: this._projectId,
            });

            return {
                success: true,
                results,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error("[ConversationRegistry] Advanced search failed", {
                error: errorMessage,
                query: input.query,
            });

            return {
                success: false,
                results: [],
                error: errorMessage,
            };
        }
    }

    /**
     * Trigger an index update for a conversation.
     * Updates are debounced (30 seconds) to avoid excessive I/O.
     */
    triggerIndexUpdate(conversationId: string): void {
        if (!this._projectId) return;

        try {
            const indexManager = getIndexManager(this._basePath, this._projectId);
            indexManager.triggerUpdate(conversationId);
        } catch (error) {
            logger.warn("[ConversationRegistry] Failed to trigger index update", {
                conversationId: conversationId.substring(0, 8),
                error,
            });
        }
    }

    /**
     * Rebuild the search index from scratch.
     * Use sparingly as this scans all conversation files.
     */
    rebuildSearchIndex(): void {
        if (!this._projectId) return;

        try {
            const indexManager = getIndexManager(this._basePath, this._projectId);
            indexManager.rebuildIndex();
        } catch (error) {
            logger.error("[ConversationRegistry] Failed to rebuild search index", { error });
        }
    }

    /**
     * Get the conversations directory for the current project.
     */
    getConversationsDir(): string | null {
        if (!this._projectId) return null;
        return join(this._basePath, this._projectId, "conversations");
    }

    /**
     * List conversation IDs from disk for current project.
     */
    listConversationIdsFromDisk(): string[] {
        if (!this._projectId) return [];
        return listConversationIdsFromDiskForProject(this._basePath, this._projectId);
    }

    /**
     * List all project IDs from disk.
     */
    listProjectIdsFromDisk(): string[] {
        return listProjectIdsFromDisk(this._basePath);
    }

    /**
     * List conversation IDs for a specific project.
     */
    listConversationIdsFromDiskForProject(projectId: string): string[] {
        return listConversationIdsFromDiskForProject(this._basePath, projectId);
    }

    /**
     * Check if a pubkey belongs to an agent.
     */
    isAgentPubkey(pubkey: string): boolean {
        return this._agentPubkeys.has(pubkey);
    }

    /**
     * Read lightweight metadata without loading full store.
     */
    readLightweightMetadata(conversationId: string) {
        if (!this._projectId) return null;
        return readLightweightMetadata(this._basePath, this._projectId, conversationId);
    }

    /**
     * Read messages from disk without caching.
     */
    readMessagesFromDisk(conversationId: string) {
        if (!this._projectId) return null;
        return readMessagesFromDisk(this._basePath, this._projectId, conversationId);
    }

    /**
     * Read conversation preview data.
     */
    readConversationPreview(conversationId: string, agentPubkey: string) {
        if (!this._projectId) return null;
        return readConversationPreviewForProject(this._basePath, conversationId, agentPubkey, this._projectId);
    }

    /**
     * Read conversation preview for a specific project.
     */
    readConversationPreviewForProject(conversationId: string, agentPubkey: string, projectId: string) {
        return readConversationPreviewForProject(this._basePath, conversationId, agentPubkey, projectId);
    }

    /**
     * Reset all state (for testing).
     */
    reset(): void {
        this.stores.clear();
        this.eventCache.clear();
        this._basePath = join(getTenexBasePath(), "projects");
        this._projectId = null;
        this._agentPubkeys.clear();
    }
}

// Export singleton instance
export const conversationRegistry = new ConversationRegistryImpl();
