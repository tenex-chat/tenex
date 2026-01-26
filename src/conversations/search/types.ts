/**
 * Type definitions for the conversation search module.
 */

/**
 * Search filters for narrowing down results.
 * Note: 'after' in input is a pure alias for 'since' - only 'since' is stored after parsing.
 */
export interface SearchFilters {
    /** Filter by agent slugs or pubkeys - conversation must include at least one */
    agents?: string[];
    /** Return conversations with activity since this timestamp (Unix seconds) */
    since?: number;
}

/**
 * Parsed and validated search query.
 */
export interface SearchQuery {
    /** The text to search for in message content */
    text: string;
    /** Optional filters to narrow results */
    filters: SearchFilters;
}

/**
 * A single message match with snippet context.
 */
export interface MessageMatch {
    /** The ID of the matching message */
    messageId: string;
    /** Snippet showing the match with 50-75 char context */
    snippet: string;
}

/**
 * A conversation search result.
 */
export interface SearchResult {
    /** The conversation ID */
    conversationId: string;
    /** The conversation title */
    title?: string;
    /** Total number of messages in the conversation */
    messageCount: number;
    /** When the conversation was created (Unix timestamp in seconds) */
    createdAt?: number;
    /** When the last activity occurred (Unix timestamp in seconds) */
    lastActivity?: number;
    /** Array of matching messages with snippets */
    matches: MessageMatch[];
}

/**
 * Index entry for a single message.
 */
export interface MessageIndexEntry {
    /** Unique message identifier (index within conversation) */
    messageId: string;
    /** Full message text content for searching */
    content: string;
    /** Message timestamp (Unix seconds) */
    timestamp?: number;
    /** Sender identifier (pubkey or agent slug) */
    from?: string;
    /** Target recipient identifier */
    to?: string;
}

/**
 * Index entry for a conversation.
 */
export interface ConversationIndexEntry {
    /** The conversation ID */
    conversationId: string;
    /** Project slug/ID this conversation belongs to */
    slug: string;
    /** Conversation title */
    title?: string;
    /** Total message count */
    messageCount: number;
    /** Last message timestamp (Unix seconds) */
    lastMessageAt?: number;
    /** List of agent pubkeys that participated */
    agents: string[];
    /** Indexed messages */
    messages: MessageIndexEntry[];
}

/**
 * The full search index structure.
 */
export interface ConversationIndex {
    /** Index format version for migration compatibility */
    version: string;
    /** When the index was last updated (ISO 8601) */
    lastUpdated: string;
    /** All indexed conversations */
    conversations: ConversationIndexEntry[];
}

/**
 * Index file metadata for staleness checks.
 */
export interface IndexMetadata {
    version: string;
    lastUpdated: string;
    conversationCount: number;
}

/**
 * Result of an advanced search operation.
 * Includes explicit error information when applicable.
 */
export interface AdvancedSearchResult {
    /** Whether the search completed successfully */
    success: boolean;
    /** Search results (empty array if error) */
    results: SearchResult[];
    /** Error message if success is false */
    error?: string;
    /** Whether fallback to title-only search was used */
    usedFallback?: boolean;
}
