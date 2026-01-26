/**
 * ConversationIndexManager - Handles JSON index I/O with debounced updates.
 *
 * Responsibilities:
 * - Load index from disk or rebuild if missing
 * - Rebuild index by scanning all conversation files
 * - Debounced incremental updates (30 seconds)
 * - Atomic writes (temp file + rename)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { logger } from "@/utils/logger";
import type {
    ConversationIndex,
    ConversationIndexEntry,
    MessageIndexEntry,
} from "./types";
import {
    listConversationIdsFromDiskForProject,
    readLightweightMetadata,
    readMessagesFromDisk,
} from "../ConversationDiskReader";
import type { ConversationEntry } from "../types";

/** Current index format version */
const INDEX_VERSION = "1.0";

/** Debounce delay for index updates (30 seconds) */
const DEBOUNCE_MS = 30_000;

/** Index filename */
const INDEX_FILENAME = "conversation-search-index.json";

/**
 * State for debounced updates.
 */
interface DebounceState {
    timerId: NodeJS.Timeout | null;
    pendingConversationIds: Set<string>;
}

/**
 * Manages the conversation search index.
 */
export class ConversationIndexManager {
    private basePath: string;
    private projectId: string;
    private cachedIndex: ConversationIndex | null = null;
    private debounceState: DebounceState = {
        timerId: null,
        pendingConversationIds: new Set(),
    };

    constructor(basePath: string, projectId: string) {
        this.basePath = basePath;
        this.projectId = projectId;
    }

    /**
     * Get the path to the index file.
     */
    private getIndexPath(): string {
        return join(this.basePath, this.projectId, ".tenex", INDEX_FILENAME);
    }

    /**
     * Ensure the .tenex directory exists.
     */
    private ensureDirectory(): void {
        const dir = dirname(this.getIndexPath());
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * Load the index from disk.
     * Returns null if the index doesn't exist or is invalid.
     */
    private loadFromDisk(): ConversationIndex | null {
        const indexPath = this.getIndexPath();
        try {
            if (!existsSync(indexPath)) {
                return null;
            }
            const content = readFileSync(indexPath, "utf-8");
            const parsed = JSON.parse(content) as ConversationIndex;

            // Version check
            if (parsed.version !== INDEX_VERSION) {
                logger.info("[ConversationIndexManager] Index version mismatch, will rebuild", {
                    found: parsed.version,
                    expected: INDEX_VERSION,
                });
                return null;
            }

            return parsed;
        } catch (error) {
            logger.warn("[ConversationIndexManager] Failed to load index", { error });
            return null;
        }
    }

    /**
     * Save the index to disk atomically.
     */
    private saveToDisk(index: ConversationIndex): void {
        this.ensureDirectory();
        const indexPath = this.getIndexPath();
        const tempPath = indexPath + ".tmp";

        try {
            // Write to temp file
            writeFileSync(tempPath, JSON.stringify(index, null, 2));

            // Atomic rename
            renameSync(tempPath, indexPath);

            logger.debug("[ConversationIndexManager] Index saved", {
                conversationCount: index.conversations.length,
            });
        } catch (error) {
            logger.error("[ConversationIndexManager] Failed to save index", { error });
            // Clean up temp file if it exists
            try {
                if (existsSync(tempPath)) {
                    require("fs").unlinkSync(tempPath);
                }
            } catch {
                // Ignore cleanup errors
            }
            throw error;
        }
    }

    /**
     * Index a single conversation from disk.
     */
    private indexConversation(conversationId: string): ConversationIndexEntry | null {
        try {
            const metadata = readLightweightMetadata(this.basePath, this.projectId, conversationId);
            const messages = readMessagesFromDisk(this.basePath, this.projectId, conversationId);

            if (!messages || messages.length === 0) {
                return null;
            }

            // Extract agents (unique pubkeys)
            const agentSet = new Set<string>();
            for (const msg of messages) {
                if (msg.pubkey) {
                    agentSet.add(msg.pubkey);
                }
            }

            // Index messages (only text messages with content)
            const indexedMessages: MessageIndexEntry[] = [];
            for (let i = 0; i < messages.length; i++) {
                const msg = messages[i] as ConversationEntry;
                if (msg.messageType === "text" && msg.content && msg.content.trim().length > 0) {
                    indexedMessages.push({
                        messageId: `msg-${i}`,
                        content: msg.content,
                        timestamp: msg.timestamp,
                        from: msg.pubkey,
                        to: msg.targetedPubkeys?.[0],
                    });
                }
            }

            // Calculate lastMessageAt from the last message with a timestamp
            let lastMessageAt: number | undefined;
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].timestamp) {
                    lastMessageAt = messages[i].timestamp;
                    break;
                }
            }

            return {
                conversationId,
                slug: this.projectId,
                title: metadata?.title,
                messageCount: messages.length,
                lastMessageAt,
                agents: Array.from(agentSet),
                messages: indexedMessages,
            };
        } catch (error) {
            logger.warn("[ConversationIndexManager] Failed to index conversation", {
                conversationId: conversationId.substring(0, 8),
                error,
            });
            return null;
        }
    }

    /**
     * Rebuild the entire index from scratch.
     */
    rebuildIndex(): ConversationIndex {
        logger.info("[ConversationIndexManager] Rebuilding index", { projectId: this.projectId });

        const conversationIds = listConversationIdsFromDiskForProject(this.basePath, this.projectId);
        const conversations: ConversationIndexEntry[] = [];

        for (const convId of conversationIds) {
            const entry = this.indexConversation(convId);
            if (entry) {
                conversations.push(entry);
            }
        }

        const index: ConversationIndex = {
            version: INDEX_VERSION,
            lastUpdated: new Date().toISOString(),
            conversations,
        };

        // Save to disk
        this.saveToDisk(index);
        this.cachedIndex = index;

        logger.info("[ConversationIndexManager] Index rebuilt", {
            conversationCount: conversations.length,
            projectId: this.projectId,
        });

        return index;
    }

    /**
     * Get the current index, loading from disk or rebuilding if necessary.
     */
    getIndex(): ConversationIndex {
        // Return cached index if available
        if (this.cachedIndex) {
            return this.cachedIndex;
        }

        // Try to load from disk
        const loaded = this.loadFromDisk();
        if (loaded) {
            this.cachedIndex = loaded;
            return loaded;
        }

        // Rebuild index
        return this.rebuildIndex();
    }

    /**
     * Trigger a debounced update for a specific conversation.
     * Updates will be batched and applied after 30 seconds.
     */
    triggerUpdate(conversationId: string): void {
        this.debounceState.pendingConversationIds.add(conversationId);

        // If timer already running, let it handle the update
        if (this.debounceState.timerId) {
            return;
        }

        // Schedule debounced update
        this.debounceState.timerId = setTimeout(() => {
            this.flushPendingUpdates();
        }, DEBOUNCE_MS);
    }

    /**
     * Flush all pending updates immediately.
     */
    private flushPendingUpdates(): void {
        if (this.debounceState.timerId) {
            clearTimeout(this.debounceState.timerId);
            this.debounceState.timerId = null;
        }

        const pendingIds = Array.from(this.debounceState.pendingConversationIds);
        this.debounceState.pendingConversationIds.clear();

        if (pendingIds.length === 0) {
            return;
        }

        logger.debug("[ConversationIndexManager] Flushing pending updates", {
            count: pendingIds.length,
        });

        // Get current index
        const index = this.getIndex();

        // Update each conversation
        for (const convId of pendingIds) {
            const newEntry = this.indexConversation(convId);

            // Find existing entry index
            const existingIndex = index.conversations.findIndex(
                (c) => c.conversationId === convId
            );

            if (newEntry) {
                if (existingIndex >= 0) {
                    // Update existing
                    index.conversations[existingIndex] = newEntry;
                } else {
                    // Add new
                    index.conversations.push(newEntry);
                }
            } else if (existingIndex >= 0) {
                // Conversation no longer exists, remove it
                index.conversations.splice(existingIndex, 1);
            }
        }

        // Update timestamp and save
        index.lastUpdated = new Date().toISOString();
        this.saveToDisk(index);
        this.cachedIndex = index;
    }

    /**
     * Force an immediate update for a conversation (no debouncing).
     */
    updateConversationNow(conversationId: string): void {
        const index = this.getIndex();
        const newEntry = this.indexConversation(conversationId);

        const existingIndex = index.conversations.findIndex(
            (c) => c.conversationId === conversationId
        );

        if (newEntry) {
            if (existingIndex >= 0) {
                index.conversations[existingIndex] = newEntry;
            } else {
                index.conversations.push(newEntry);
            }
        } else if (existingIndex >= 0) {
            index.conversations.splice(existingIndex, 1);
        }

        index.lastUpdated = new Date().toISOString();
        this.saveToDisk(index);
        this.cachedIndex = index;
    }

    /**
     * Invalidate the cached index, forcing a reload on next access.
     */
    invalidateCache(): void {
        this.cachedIndex = null;
    }

    /**
     * Clean up resources (timers, etc.).
     */
    cleanup(): void {
        if (this.debounceState.timerId) {
            clearTimeout(this.debounceState.timerId);
            this.debounceState.timerId = null;
        }
        this.debounceState.pendingConversationIds.clear();
    }
}

/** Singleton instances per project */
const instances = new Map<string, ConversationIndexManager>();

/**
 * Get or create an index manager for a project.
 */
export function getIndexManager(basePath: string, projectId: string): ConversationIndexManager {
    const key = `${basePath}:${projectId}`;
    let manager = instances.get(key);
    if (!manager) {
        manager = new ConversationIndexManager(basePath, projectId);
        instances.set(key, manager);
    }
    return manager;
}

/**
 * Clear all cached instances (for testing).
 */
export function clearIndexManagerInstances(): void {
    for (const manager of instances.values()) {
        manager.cleanup();
    }
    instances.clear();
}
