/**
 * Conversation search module exports.
 */

// Types
export type {
    AdvancedSearchResult,
    ConversationIndex,
    ConversationIndexEntry,
    IndexMetadata,
    MessageIndexEntry,
    MessageMatch,
    SearchFilters,
    SearchQuery,
    SearchResult,
} from "./types";

// Query Parser
export {
    getEffectiveSinceTimestamp,
    parseQuery,
    parseTimestamp,
    type RawSearchInput,
} from "./QueryParser";

// Snippet Extractor
export {
    extractAllSnippets,
    extractSnippet,
    type SnippetResult,
} from "./SnippetExtractor";

// Search Engine
export {
    search,
    searchByTitleOnly,
} from "./SearchEngine";

// Index Manager
export {
    clearIndexManagerInstances,
    ConversationIndexManager,
    getIndexManager,
} from "./ConversationIndexManager";
