/**
 * Unified Search Type Definitions
 *
 * Interfaces for the search provider pattern that enables querying
 * across multiple RAG collections (reports, conversations, lessons).
 */

/**
 * A single search result from any collection.
 * Contains enough metadata for the agent to:
 * 1. Understand what the result is about
 * 2. Retrieve the full document via the appropriate tool
 *    (report_read, lesson_get, conversation_get)
 */
export interface SearchResult {
    /** Source collection name (e.g., "reports", "conversations", "lessons") */
    source: string;

    /** Identifier for retrieving the full document.
     * - Reports: slug
     * - Lessons: nevent/note encoded ID
     * - Conversations: conversation ID
     */
    id: string;

    /** Project ID this result belongs to */
    projectId: string;

    /** Relevance score from vector search (0-1, higher is better) */
    relevanceScore: number;

    /** Human-readable title */
    title: string;

    /** Brief summary or snippet of the content */
    summary: string;

    /** Unix timestamp of when the content was created/published */
    createdAt?: number;

    /** Unix timestamp of last update/activity */
    updatedAt?: number;

    /** Author pubkey */
    author?: string;

    /** Author display name */
    authorName?: string;

    /** Hashtags/categories for additional context */
    tags?: string[];

    /** Which tool to use to retrieve full content */
    retrievalTool: "report_read" | "lesson_get" | "conversation_get" | "rag_search";

    /** The argument to pass to the retrieval tool */
    retrievalArg: string;
}

/**
 * Options for performing a unified search.
 */
export interface SearchOptions {
    /** Natural language search query */
    query: string;

    /** Project ID for project-scoped isolation */
    projectId: string;

    /** Maximum results per collection */
    limit?: number;

    /** Minimum relevance score threshold (0-1) */
    minScore?: number;

    /** Optional prompt for LLM-based extraction/focusing.
     * When provided, results are processed through a fast LLM to
     * extract information relevant to this specific prompt.
     */
    prompt?: string;

    /**
     * Filter by **provider name** (defaults to all).
     * Well-known provider names: "reports", "conversations", "lessons".
     * Dynamically discovered RAG collections use their collection name as provider name
     * (e.g., "custom_knowledge").
     *
     * When provided, searches exactly those collections (no scope filtering).
     */
    collections?: string[];

    /**
     * Agent pubkey for scope-aware collection filtering.
     * Used to include `personal` collections belonging to this agent.
     */
    agentPubkey?: string;
}

/**
 * Interface that each search provider must implement.
 * Each provider wraps a specific RAG collection.
 */
export interface SearchProvider {
    /** Unique name for this provider (used for filtering via `collections` parameter) */
    readonly name: string;

    /** Human-readable description */
    readonly description: string;

    /**
     * The underlying RAG collection name this provider covers.
     * Used to prevent duplicate generic providers for collections that already
     * have a specialized provider. When undefined, the provider is not
     * associated with a specific RAG collection (or uses its `name` directly).
     */
    readonly collectionName?: string;

    /**
     * Perform semantic search within this provider's collection.
     *
     * @param query - Natural language search query
     * @param projectId - Project ID for isolation
     * @param limit - Maximum number of results
     * @param minScore - Minimum relevance score threshold
     * @returns Array of search results
     */
    search(
        query: string,
        projectId: string,
        limit: number,
        minScore: number
    ): Promise<SearchResult[]>;
}

/**
 * Output from the unified search tool.
 */
export interface UnifiedSearchOutput {
    /** Whether the search succeeded */
    success: boolean;

    /** Combined results from all collections, sorted by relevance */
    results: SearchResult[];

    /** Total number of results found */
    totalResults: number;

    /** The original query */
    query: string;

    /** Which collections were searched */
    collectionsSearched: string[];

    /** Which collections had errors (graceful degradation) */
    collectionsErrored?: string[];

    /** Warnings (e.g., collection failures) */
    warnings?: string[];

    /** Extracted/focused content when a prompt was provided */
    extraction?: string;

    /** Error message if the entire search failed */
    error?: string;
}
