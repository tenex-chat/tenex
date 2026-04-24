/**
 * VectorStore provider abstraction for RAG backends.
 *
 * Each provider normalizes its native distance/similarity metric
 * to a 0-1 score (higher = more similar) so callers never need
 * to know which metric the backend uses.
 */

/**
 * Document as stored in the vector database.
 * All providers use this same shape for storage and retrieval.
 */
export interface StoredDocument {
    id: string;
    content: string;
    vector: number[];
    metadata: string; // JSON-serialized DocumentMetadata
    timestamp: number;
    source: string;
}

/**
 * A search result with normalized similarity score.
 */
export interface VectorSearchResult {
    document: StoredDocument;
    /** Similarity score normalized to 0-1 (higher = more similar) */
    score: number;
}

/**
 * Configuration for vector store provider selection.
 */
export interface VectorStoreConfig {
    provider: "sqlite-vec" | "qdrant";
    /** Custom data directory (SQLite-vec) */
    path?: string;
    /** Server URL (Qdrant) */
    url?: string;
    /** API key (Qdrant) */
    apiKey?: string;
}

export const DEFAULT_VECTOR_STORE_CONFIG: VectorStoreConfig = {
    provider: "sqlite-vec",
};

/**
 * Abstract interface for vector database backends.
 *
 * Implementations handle connection management, schema creation,
 * document CRUD, vector search, and provider-specific maintenance.
 */
export interface VectorStore {
    /** Initialize connections and verify backend availability */
    initialize(): Promise<void>;

    /** Close connections and release resources */
    close(): Promise<void>;

    // -- Collection management --

    createCollection(name: string, dimensions: number): Promise<void>;
    deleteCollection(name: string): Promise<void>;
    listCollections(): Promise<string[]>;
    collectionExists(name: string): Promise<boolean>;
    getCollectionDimensions(name: string): Promise<number | null>;

    // -- Document operations --

    addDocuments(collection: string, documents: StoredDocument[]): Promise<void>;

    /**
     * Upsert documents by ID: update existing, insert new.
     * Failures are isolated per batch; returned indices indicate which failed.
     */
    upsertDocuments(
        collection: string,
        documents: StoredDocument[]
    ): Promise<{ upsertedCount: number; failedIndices: number[] }>;

    deleteDocument(collection: string, documentId: string): Promise<void>;

    /**
     * Read all documents from a collection (for migration).
     * Returns documents in batches via limit/offset pagination.
     */
    getAllDocuments(
        collection: string,
        limit: number,
        offset: number
    ): Promise<StoredDocument[]>;

    // -- Search --

    /**
     * Semantic vector search with optional metadata filter.
     * Filter format: SQL-style LIKE pattern on the metadata column
     * (e.g., `metadata LIKE '%"projectId":"abc"%'`).
     * Each provider translates this to its native filter syntax.
     */
    search(
        collection: string,
        vector: number[],
        topK: number,
        filter?: string
    ): Promise<VectorSearchResult[]>;

    // -- Stats --

    countDocuments(collection: string, filter?: string): Promise<number>;

    // -- Maintenance --

    /**
     * Run provider-specific maintenance (compaction, vacuum, etc.).
     * No-op for providers that handle this internally.
     */
    runMaintenance(): Promise<void>;
}
