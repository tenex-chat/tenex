/**
 * Presentation layer for conversations - formats catalog data for display
 *
 * This layer sits between ConversationCatalogService (data layer) and tools (presentation layer).
 * It handles ID shortening and other display formatting, keeping the catalog service canonical.
 */

import type {
    ConversationCatalogPreview,
    ConversationCatalogListEntry,
    ConversationCatalogParticipant,
} from "../ConversationCatalogService";
import { shortenConversationId } from "@/utils/conversation-id";

/**
 * Conversation preview formatted for display (shortened IDs)
 */
export interface ConversationDisplayPreview {
    /** Shortened conversation ID (10 chars) for display */
    id: string;
    /** Full canonical ID for internal use/lookups */
    fullId: string;
    title?: string;
    summary?: string;
    lastUserMessage?: string;
    statusLabel?: string;
    statusCurrentActivity?: string;
    messageCount: number;
    createdAt?: number;
    lastActivity: number;
}

/**
 * Full conversation list entry formatted for display
 */
export interface ConversationDisplayEntry extends ConversationDisplayPreview {
    participants: ConversationCatalogParticipant[];
    /** Shortened delegation IDs for display */
    delegationIds: string[];
    /** Full canonical delegation IDs for lookups */
    fullDelegationIds: string[];
}

/**
 * ConversationPresenter - converts catalog data to display format
 *
 * Responsibilities:
 * - Shorten conversation IDs for display
 * - Shorten delegation IDs
 * - Keep full IDs available for lookups
 * - Format data for tool consumption
 */
export class ConversationPresenter {
    /**
     * Convert a catalog preview to display format
     */
    static formatPreview(preview: ConversationCatalogPreview): ConversationDisplayPreview {
        return {
            id: shortenConversationId(preview.id),
            fullId: preview.id,
            title: preview.title,
            summary: preview.summary,
            lastUserMessage: preview.lastUserMessage,
            statusLabel: preview.statusLabel,
            statusCurrentActivity: preview.statusCurrentActivity,
            messageCount: preview.messageCount,
            createdAt: preview.createdAt,
            lastActivity: preview.lastActivity,
        };
    }

    /**
     * Convert a catalog list entry to display format
     */
    static formatListEntry(entry: ConversationCatalogListEntry): ConversationDisplayEntry {
        return {
            ...ConversationPresenter.formatPreview(entry),
            participants: entry.participants,
            delegationIds: entry.delegationIds.map(id => shortenConversationId(id)),
            fullDelegationIds: entry.delegationIds,
        };
    }

    /**
     * Convert multiple catalog previews to display format
     */
    static formatPreviews(previews: ConversationCatalogPreview[]): ConversationDisplayPreview[] {
        return previews.map(p => ConversationPresenter.formatPreview(p));
    }

    /**
     * Convert multiple catalog list entries to display format
     */
    static formatListEntries(entries: ConversationCatalogListEntry[]): ConversationDisplayEntry[] {
        return entries.map(e => ConversationPresenter.formatListEntry(e));
    }
}
