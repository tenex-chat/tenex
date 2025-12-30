import { NDKKind } from "@/nostr/kinds";
import type { ProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { homedir } from "os";
import { join } from "path";
import { ConversationStore, type ConversationMetadata } from "../ConversationStore";
import { ConversationSummarizer } from "./ConversationSummarizer";

/**
 * ConversationCoordinator - Manages conversation stores
 *
 * Uses disk-based ConversationStore as the single source of truth.
 * Each conversation has its own store file on disk.
 */
export class ConversationCoordinator {
    private projectId: string;
    private basePath: string;
    private stores: Map<string, ConversationStore> = new Map();
    private summarizer?: ConversationSummarizer;
    private agentPubkeys: Set<string>;
    // Cache of NDKEvents by ID for delegation resumption lookups
    private eventCache: Map<string, NDKEvent> = new Map();

    constructor(
        projectPath: string,
        _persistence?: unknown, // Kept for backwards compat, ignored
        context?: ProjectContext
    ) {
        if (!projectPath || projectPath === "undefined") {
            throw new Error(
                `ConversationCoordinator requires a valid projectPath. Received: ${String(projectPath)}`
            );
        }

        // Extract project ID from path (last segment)
        const segments = projectPath.split("/").filter(Boolean);
        this.projectId = segments[segments.length - 1] || "unknown";
        this.basePath = join(homedir(), ".tenex");

        // Build set of agent pubkeys for isFromAgent checks
        this.agentPubkeys = new Set();
        if (context) {
            for (const agent of context.agents.values()) {
                this.agentPubkeys.add(agent.pubkey);
            }
            this.summarizer = new ConversationSummarizer(context);
        }
    }

    async initialize(): Promise<void> {
        // Nothing to initialize - stores are loaded on demand
    }

    /**
     * Get or create a ConversationStore for a conversation
     */
    getStore(conversationId: string): ConversationStore {
        let store = this.stores.get(conversationId);
        if (!store) {
            store = new ConversationStore(this.basePath);
            store.load(this.projectId, conversationId);
            this.stores.set(conversationId, store);
        }
        return store;
    }

    /**
     * Create a new conversation from an event
     */
    async createConversation(event: NDKEvent): Promise<ConversationStore> {
        const eventId = event.id;
        if (!eventId) {
            throw new Error("Event must have an ID to create a conversation");
        }

        // Check if already exists
        const existingStore = this.stores.get(eventId);
        if (existingStore) {
            logger.debug(`Conversation ${eventId.substring(0, 8)} already exists`);
            return existingStore;
        }

        // Create new store
        const store = new ConversationStore(this.basePath);
        store.load(this.projectId, eventId);

        // Add the initial event
        const isFromAgent = this.agentPubkeys.has(event.pubkey);
        store.addEventMessage(event, isFromAgent);

        // Cache the event for later retrieval (e.g., delegation resumption)
        this.eventCache.set(eventId, event);

        // Set initial title from content preview
        if (event.content) {
            store.setTitle(event.content.substring(0, 50) + (event.content.length > 50 ? "..." : ""));
        }

        await store.save();
        this.stores.set(eventId, store);

        logger.info(`Starting conversation ${eventId.substring(0, 8)} - "${event.content?.substring(0, 50)}..."`);

        return store;
    }

    /**
     * Get a conversation store by ID
     */
    getConversation(id: string): ConversationStore | undefined {
        return this.stores.get(id) || this.tryLoadStore(id);
    }

    /**
     * Try to load a store from disk
     */
    private tryLoadStore(conversationId: string): ConversationStore | undefined {
        const store = new ConversationStore(this.basePath);
        try {
            store.load(this.projectId, conversationId);
            // Check if it has any messages (was actually loaded)
            if (store.getAllMessages().length > 0) {
                this.stores.set(conversationId, store);
                return store;
            }
        } catch {
            // Store doesn't exist
        }
        return undefined;
    }

    /**
     * Check if a conversation exists
     */
    hasConversation(id: string): boolean {
        return this.stores.has(id) || this.tryLoadStore(id) !== undefined;
    }

    /**
     * Set the title of a conversation
     */
    setTitle(conversationId: string, title: string): void {
        const store = this.getConversation(conversationId);
        if (store) {
            store.setTitle(title);
        }
    }

    /**
     * Get all loaded conversations
     */
    getAllConversations(): ConversationStore[] {
        return Array.from(this.stores.values());
    }

    /**
     * Add an event to a conversation
     */
    async addEvent(conversationId: string, event: NDKEvent): Promise<void> {
        let store = this.stores.get(conversationId);
        if (!store) {
            // Try to load from disk
            store = this.tryLoadStore(conversationId);
            if (!store) {
                throw new Error(`Conversation ${conversationId} not found`);
            }
        }

        const isFromAgent = this.agentPubkeys.has(event.pubkey);
        store.addEventMessage(event, isFromAgent);

        // Cache the event for later retrieval (e.g., delegation resumption)
        if (event.id) {
            this.eventCache.set(event.id, event);
        }

        // Schedule summarization if not a metadata event
        if (this.summarizer && event.kind !== NDKKind.EventMetadata) {
            // Summarization would need store access - can implement later
        }

        await store.save();
    }

    /**
     * Get a cached NDKEvent by ID.
     * Used for delegation resumption to retrieve the original triggering event.
     */
    getEventById(eventId: string): NDKEvent | undefined {
        return this.eventCache.get(eventId);
    }

    /**
     * Update conversation metadata
     */
    async updateMetadata(
        conversationId: string,
        metadata: Partial<ConversationMetadata>
    ): Promise<void> {
        const store = this.getConversation(conversationId);
        if (!store) {
            throw new Error(`Conversation ${conversationId} not found`);
        }

        store.updateMetadata(metadata);
        await store.save();
    }

    /**
     * Archive a conversation (remove from memory and clean up caches)
     */
    async archiveConversation(conversationId: string): Promise<void> {
        const store = this.stores.get(conversationId);
        if (store) {
            // Clean up event cache for this conversation's events
            for (const entry of store.getAllMessages()) {
                if (entry.eventId) {
                    this.eventCache.delete(entry.eventId);
                }
            }
        }
        this.stores.delete(conversationId);
    }

    /**
     * Clean up - save all loaded stores
     */
    async cleanup(): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const store of this.stores.values()) {
            promises.push(store.save());
        }
        await Promise.all(promises);
    }

    /**
     * Complete a conversation
     */
    async completeConversation(conversationId: string): Promise<void> {
        const store = this.stores.get(conversationId);
        if (store) {
            await store.save();
            // Clean up event cache for this conversation's events
            for (const entry of store.getAllMessages()) {
                if (entry.eventId) {
                    this.eventCache.delete(entry.eventId);
                }
            }
            this.stores.delete(conversationId);
        }
    }

    /**
     * Find a conversation by an event ID it contains
     */
    findConversationByEvent(eventId: string): ConversationStore | undefined {
        // Check loaded stores first
        for (const store of this.stores.values()) {
            if (store.hasEventId(eventId)) {
                return store;
            }
        }
        return undefined;
    }

    /**
     * Get a conversation by event ID (alias for findConversationByEvent)
     */
    getConversationByEvent(eventId: string): ConversationStore | undefined {
        return this.findConversationByEvent(eventId);
    }

    /**
     * Search conversations by title
     */
    async searchConversations(query: string): Promise<ConversationStore[]> {
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
}
