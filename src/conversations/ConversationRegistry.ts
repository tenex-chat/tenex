/**
 * ConversationRegistry - Global registry for conversation stores
 *
 * This singleton manages the lifecycle of ConversationStore instances:
 * - Loading and caching conversation stores
 * - Event caching for fast lookup
 * - Project-level initialization (multi-project safe)
 * - Cross-project conversation discovery
 *
 * Multi-project support:
 * initialize() accumulates per-project configs instead of overwriting.
 * Methods that need a project ID resolve it via three-tier strategy:
 *   1. Explicit projectId parameter (if passed)
 *   2. AsyncLocalStorage projectContextStore lookup
 *   3. Legacy fallback (last initialized) with warning log
 *
 * The heavy lifting is delegated to individual ConversationStore instances.
 */

import { existsSync, readdirSync } from "fs";
import { basename, dirname, join } from "path";
import { getTenexBasePath } from "@/constants";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { logger } from "@/utils/logger";
// Import directly from the module file (not the barrel) to avoid circular
// dependency: barrel re-exports ProjectContext → @/agents → ConversationStore
// → ConversationRegistry (this file), which would trigger a ReferenceError.
import { projectContextStore } from "@/services/projects/ProjectContextStore";
import { createProjectDTag, type ProjectDTag } from "@/types/project-ids";
import type { ConversationMetadata } from "./types";
import type { MessagePrincipalContext } from "./types";
import type { ConversationStore } from "./ConversationStore";
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
import { isHexPrefix, resolvePrefixToId, PREFIX_LENGTH } from "@/utils/nostr-entity-parser";
import { prefixKVStore } from "@/services/storage";

// ConversationStore class is registered from ConversationStore module to avoid circular imports.
let ConversationStoreClass: typeof ConversationStore | null = null;

function getConversationStoreClass(): typeof ConversationStore {
    if (!ConversationStoreClass) {
        throw new Error("ConversationStore class not registered. Ensure ConversationStore module is loaded.");
    }
    return ConversationStoreClass;
}

/**
 * Per-project configuration stored by the registry.
 */
interface ProjectRegistryConfig {
    agentPubkeys: Set<string>;
}

/**
 * Singleton registry for managing conversation stores
 */
class ConversationRegistryImpl {
    private stores: Map<string, ConversationStore> = new Map();
    private envelopeCache: Map<string, InboundEnvelope> = new Map();
    private _basePath: string = join(getTenexBasePath(), "projects");

    /**
     * Per-project configurations keyed by ProjectDTag.
     * Accumulated by initialize() — never overwritten.
     */
    private _projectConfigs: Map<ProjectDTag, ProjectRegistryConfig> = new Map();

    /**
     * Union of all agent pubkeys across all initialized projects.
     * Maintained alongside _projectConfigs for efficient lookup.
     */
    private _allAgentPubkeys: Set<string> = new Set();

    /**
     * Legacy fallback: the last projectId set via initialize().
     * Used only when AsyncLocalStorage context is unavailable (backward compat).
     */
    private _legacyProjectId: ProjectDTag | null = null;

    get basePath(): string {
        return this._basePath;
    }

    /**
     * Get the current project ID via three-tier resolution.
     * Prefer resolveProjectId() for new code paths.
     */
    get projectId(): ProjectDTag | null {
        return this.resolveProjectId();
    }

    /**
     * Get agent pubkeys for the current resolved project.
     * Falls back to all known agent pubkeys if no project can be resolved.
     */
    get agentPubkeys(): Set<string> {
        return this.getAgentPubkeysForProject(this.resolveProjectId());
    }

    setConversationStoreClass(StoreClass: typeof ConversationStore): void {
        ConversationStoreClass = StoreClass;
    }

    /**
     * Resolve the current project ID via three-tier strategy:
     *   1. Explicit projectId parameter (if passed)
     *   2. AsyncLocalStorage projectContextStore lookup
     *   3. Legacy fallback (last initialized) with warning log
     *
     * @param explicitProjectId - Optional explicit project ID to use directly
     * @returns The resolved project ID, or null if none can be determined
     */
    resolveProjectId(explicitProjectId?: ProjectDTag): ProjectDTag | null {
        // Tier 1: Explicit parameter
        if (explicitProjectId) {
            return explicitProjectId;
        }

        // Tier 2: AsyncLocalStorage context
        try {
            const context = projectContextStore.getContext();
            if (context) {
                const dTag = context.project.tagValue("d");
                if (dTag) {
                    const typedDTag = createProjectDTag(dTag);
                    if (this._projectConfigs.has(typedDTag)) {
                        return typedDTag;
                    }
                }
            }
        } catch (error) {
            logger.debug("[ConversationRegistry] Failed to read AsyncLocalStorage context", { error });
        }

        // Tier 3: Legacy fallback with warning
        if (this._legacyProjectId) {
            // Only warn if there are multiple projects (single project is expected)
            if (this._projectConfigs.size > 1) {
                logger.warn(
                    "[ConversationRegistry] Using legacy projectId fallback — " +
                    "this may resolve to the wrong project in multi-project mode",
                    { projectId: this._legacyProjectId, knownProjects: this._projectConfigs.size }
                );
            }
            return this._legacyProjectId;
        }

        return null;
    }

    /**
     * Rebuild the union of all agent pubkeys from all project configs.
     * Called after any mutation to _projectConfigs to keep _allAgentPubkeys in sync.
     */
    private rebuildAllAgentPubkeys(): void {
        this._allAgentPubkeys = new Set();
        for (const config of this._projectConfigs.values()) {
            for (const pk of config.agentPubkeys) {
                this._allAgentPubkeys.add(pk);
            }
        }
    }

    /**
     * Get the agent pubkeys for a specific resolved project ID.
     * Returns the project-specific set if found, otherwise the union of all.
     */
    private getAgentPubkeysForProject(projectId: ProjectDTag | null): Set<string> {
        if (projectId) {
            const config = this._projectConfigs.get(projectId);
            if (config) {
                return config.agentPubkeys;
            }
        }
        return this._allAgentPubkeys;
    }

    /**
     * Resolve a conversation ID that may be a 12-char prefix to a full 64-char ID.
     * Returns the input as-is if it's already a full ID or if resolution fails.
     *
     * @param conversationId - Either a full 64-char hex ID or a 12-char hex prefix
     * @returns The full 64-char ID if resolved, otherwise the original input
     */
    private resolveConversationId(conversationId: string): string {
        // Already a full ID (64 hex chars)
        if (/^[0-9a-fA-F]{64}$/.test(conversationId)) {
            return conversationId.toLowerCase();
        }

        // Check if it's a 12-char hex prefix
        if (isHexPrefix(conversationId)) {
            const resolved = resolvePrefixToId(conversationId);
            if (resolved) {
                logger.debug(`[ConversationRegistry] Resolved prefix ${conversationId} to ${resolved.substring(0, 12)}...`);
                return resolved;
            }
            // Fall through to return original if resolution fails
        }

        // Return as-is (may be invalid, but let caller handle)
        return conversationId;
    }

    /**
     * Initialize the registry for a project.
     * In multi-project mode (daemon), this is called once per project.
     * Accumulates per-project configs rather than overwriting.
     */
    initialize(metadataPath: string, agentPubkeys?: Iterable<string>): void {
        this._basePath = dirname(metadataPath);
        const projectId = createProjectDTag(basename(metadataPath));
        const pubkeys = new Set(agentPubkeys ?? []);

        // Accumulate per-project config
        this._projectConfigs.set(projectId, { agentPubkeys: pubkeys });

        // Rebuild the union of all agent pubkeys
        this.rebuildAllAgentPubkeys();

        // Track last initialized for legacy fallback
        this._legacyProjectId = projectId;

        logger.info(`[ConversationRegistry] Initialized for project ${projectId}`, {
            totalProjects: this._projectConfigs.size,
        });
    }

    /**
     * Get or load a conversation store by ID.
     * Loads from disk if not already in memory.
     * Supports 12-char hex prefix lookups via PrefixKVStore.
     */
    getOrLoad(conversationId: string): ConversationStore {
        // Resolve prefix to full ID if needed (consistent with get/has)
        const resolvedId = this.resolveConversationId(conversationId);

        let store = this.stores.get(resolvedId);
        if (!store) {
            const currentProjectId = this.resolveProjectId();
            if (!currentProjectId) {
                throw new Error("ConversationRegistry.initialize() must be called before getOrLoad()");
            }
            const StoreClass = getConversationStoreClass();
            store = new StoreClass(this._basePath);
            store.load(currentProjectId, resolvedId);
            this.stores.set(resolvedId, store);
        }
        return store;
    }

    /**
     * Get a conversation store if it exists in memory or on disk.
     * Returns undefined if conversation doesn't exist.
     * Supports 12-char hex prefix lookups via PrefixKVStore.
     */
    get(conversationId: string): ConversationStore | undefined {
        // Resolve prefix to full ID if needed
        const resolvedId = this.resolveConversationId(conversationId);

        const cached = this.stores.get(resolvedId);
        if (cached) return cached;

        // Try current project first
        const currentProjectId = this.resolveProjectId();
        if (currentProjectId) {
            const StoreClass = getConversationStoreClass();
            const store = new StoreClass(this._basePath);
            try {
                store.load(currentProjectId, resolvedId);
                if (store.getAllMessages().length > 0) {
                    this.stores.set(resolvedId, store);
                    return store;
                }
            } catch {
                // Store doesn't exist
            }
        }

        // Search other projects
        const otherProjectId = this.findProjectForConversation(resolvedId, currentProjectId);
        if (otherProjectId) {
            const StoreClass = getConversationStoreClass();
            const store = new StoreClass(this._basePath);
            try {
                store.load(otherProjectId, resolvedId);
                if (store.getAllMessages().length > 0) {
                    this.stores.set(resolvedId, store);
                    logger.debug(`[ConversationRegistry] Found conversation ${resolvedId.substring(0, 8)} in project ${otherProjectId}`);
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
    private findProjectForConversation(conversationId: string, skipProjectId?: ProjectDTag | null): ProjectDTag | undefined {
        try {
            if (!existsSync(this._basePath)) return undefined;

            const projectDirs = readdirSync(this._basePath);
            for (const projectDir of projectDirs) {
                if (projectDir === skipProjectId) continue;
                if (projectDir === "metadata") continue;

                const conversationFile = join(
                    this._basePath,
                    projectDir,
                    "conversations",
                    `${conversationId}.json`
                );

                if (existsSync(conversationFile)) {
                    return createProjectDTag(projectDir);
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
     * Create a new conversation from an InboundEnvelope.
     * Indexes the conversation ID in PrefixKVStore for prefix lookups.
     * Uses three-tier project resolution to determine the correct project.
     */
    async create(envelope: InboundEnvelope, principalContext?: MessagePrincipalContext): Promise<ConversationStore> {
        const nativeId = envelope.message.nativeId;
        if (!nativeId) {
            throw new Error("Envelope must have a nativeId to create a conversation");
        }

        const existing = this.stores.get(nativeId);
        if (existing) {
            logger.debug(`Conversation ${nativeId.substring(0, 8)} already exists`);
            return existing;
        }

        const currentProjectId = this.resolveProjectId();
        if (!currentProjectId) {
            throw new Error("ConversationRegistry.initialize() must be called before create()");
        }

        const StoreClass = getConversationStoreClass();
        const store = new StoreClass(this._basePath);
        store.load(currentProjectId, nativeId);

        const projectAgentPubkeys = this.getAgentPubkeysForProject(currentProjectId);
        const senderPubkey = envelope.principal.linkedPubkey;
        const isFromAgent = senderPubkey ? projectAgentPubkeys.has(senderPubkey) : false;
        store.addEnvelopeMessage(envelope, isFromAgent, principalContext);

        this.envelopeCache.set(nativeId, envelope);

        if (envelope.content) {
            store.setTitle(envelope.content.substring(0, 50) + (envelope.content.length > 50 ? "..." : ""));
        }

        await store.save();
        this.stores.set(nativeId, store);

        if (prefixKVStore.isInitialized()) {
            try {
                await prefixKVStore.add(nativeId);
            } catch (error) {
                logger.warn(`[ConversationRegistry] Failed to index conversation ${nativeId.substring(0, PREFIX_LENGTH)} in PrefixKVStore`, { error });
            }
        }

        logger.info(`Starting conversation ${nativeId.substring(0, 8)} - "${envelope.content?.substring(0, 50)}..."`, {
            projectId: currentProjectId,
        });

        return store;
    }

    /**
     * Find a conversation by an event ID it contains.
     */
    findByEventId(eventId: string): ConversationStore | undefined {
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
    getAll(): ConversationStore[] {
        return Array.from(this.stores.values());
    }

    /**
     * Cache an InboundEnvelope by its native ID.
     */
    cacheEnvelope(envelope: InboundEnvelope): void {
        const nativeId = envelope.message.nativeId;
        if (nativeId) {
            this.envelopeCache.set(nativeId, envelope);
        }
    }

    /**
     * Get a cached InboundEnvelope by native ID.
     */
    getCachedEnvelope(nativeId: string): InboundEnvelope | undefined {
        return this.envelopeCache.get(nativeId);
    }

    /**
     * Add an envelope to a conversation.
     */
    async addEnvelope(
        conversationId: string,
        envelope: InboundEnvelope,
        principalContext?: MessagePrincipalContext
    ): Promise<void> {
        const store = this.getOrLoad(conversationId);
        const currentProjectId = this.resolveProjectId();
        const projectAgentPubkeys = this.getAgentPubkeysForProject(currentProjectId);
        const senderPubkey = envelope.principal.linkedPubkey;
        const isFromAgent = senderPubkey ? projectAgentPubkeys.has(senderPubkey) : false;
        store.addEnvelopeMessage(envelope, isFromAgent, principalContext);

        const nativeId = envelope.message.nativeId;
        if (nativeId) {
            this.envelopeCache.set(nativeId, envelope);
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
                    this.envelopeCache.delete(entry.eventId);
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
                    this.envelopeCache.delete(entry.eventId);
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
    search(query: string): ConversationStore[] {
        const results: ConversationStore[] = [];
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
        const currentProjectId = this.resolveProjectId();
        if (!currentProjectId) {
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
            const indexManager = getIndexManager(this._basePath, currentProjectId);

            // Get the index (loads from disk or rebuilds if needed)
            const index = indexManager.getIndex();

            // Perform the search
            const results = searchIndex(query, index, limit);

            logger.debug("[ConversationRegistry] Advanced search completed", {
                query: input.query,
                resultCount: results.length,
                projectId: currentProjectId,
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
        const currentProjectId = this.resolveProjectId();
        if (!currentProjectId) return;

        try {
            const indexManager = getIndexManager(this._basePath, currentProjectId);
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
        const currentProjectId = this.resolveProjectId();
        if (!currentProjectId) return;

        try {
            const indexManager = getIndexManager(this._basePath, currentProjectId);
            indexManager.rebuildIndex();
        } catch (error) {
            logger.error("[ConversationRegistry] Failed to rebuild search index", { error });
        }
    }

    /**
     * Get the conversations directory for the current project.
     */
    getConversationsDir(): string | null {
        const currentProjectId = this.resolveProjectId();
        if (!currentProjectId) return null;
        return join(this._basePath, currentProjectId, "conversations");
    }

    /**
     * List conversation IDs from disk for current project.
     */
    listConversationIdsFromDisk(): string[] {
        const currentProjectId = this.resolveProjectId();
        if (!currentProjectId) return [];
        return listConversationIdsFromDiskForProject(this._basePath, currentProjectId);
    }

    /**
     * List all project IDs from disk.
     */
    listProjectIdsFromDisk(): ProjectDTag[] {
        return listProjectIdsFromDisk(this._basePath);
    }

    /**
     * List conversation IDs for a specific project.
     */
    listConversationIdsFromDiskForProject(projectId: ProjectDTag): string[] {
        return listConversationIdsFromDiskForProject(this._basePath, projectId);
    }

    /**
     * Check if a pubkey belongs to an agent (across all initialized projects).
     */
    isAgentPubkey(pubkey: string): boolean {
        return this._allAgentPubkeys.has(pubkey);
    }

    /**
     * Read lightweight metadata without loading full store.
     */
    readLightweightMetadata(conversationId: string): ReturnType<typeof readLightweightMetadata> {
        const currentProjectId = this.resolveProjectId();
        if (!currentProjectId) return null;
        return readLightweightMetadata(this._basePath, currentProjectId, conversationId);
    }

    /**
     * Read messages from disk without caching.
     */
    readMessagesFromDisk(conversationId: string): ReturnType<typeof readMessagesFromDisk> {
        const currentProjectId = this.resolveProjectId();
        if (!currentProjectId) return null;
        return readMessagesFromDisk(this._basePath, currentProjectId, conversationId);
    }

    /**
     * Read conversation preview data.
     */
    readConversationPreview(conversationId: string, agentPubkey: string): ReturnType<typeof readConversationPreviewForProject> {
        const currentProjectId = this.resolveProjectId();
        if (!currentProjectId) return null;
        return readConversationPreviewForProject(this._basePath, conversationId, agentPubkey, currentProjectId);
    }

    /**
     * Read conversation preview for a specific project.
     */
    readConversationPreviewForProject(
        conversationId: string,
        agentPubkey: string,
        projectId: ProjectDTag
    ): ReturnType<typeof readConversationPreviewForProject> {
        return readConversationPreviewForProject(this._basePath, conversationId, agentPubkey, projectId);
    }

    /**
     * Reset all state (for testing).
     */
    reset(): void {
        this.stores.clear();
        this.envelopeCache.clear();
        this._basePath = join(getTenexBasePath(), "projects");
        this._projectConfigs.clear();
        this._allAgentPubkeys.clear();
        this._legacyProjectId = null;
    }
}

// Export singleton instance
export const conversationRegistry = new ConversationRegistryImpl();
