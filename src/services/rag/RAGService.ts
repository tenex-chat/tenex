import { logger } from "@/utils/logger";
import type { EmbeddingProvider } from "@/services/embedding";
import { EmbeddingProviderFactory } from "./EmbeddingProviderFactory";
import { RAGDatabaseService } from "./RAGDatabaseService";
import { RAGOperations } from "./RAGOperations";
import type { LanceDBSchema, RAGCollection, RAGDocument, RAGQueryResult } from "./RAGOperations";

/**
 * Facade for RAG functionality
 * Coordinates between database management and operations
 */
export class RAGService {
    private static instance: RAGService | null = null;
    private dbManager!: RAGDatabaseService;
    private operations!: RAGOperations;
    private embeddingProvider!: EmbeddingProvider;
    private initializationPromise: Promise<void>;

    private constructor() {
        this.initializationPromise = this.initialize();
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): RAGService {
        if (!RAGService.instance) {
            RAGService.instance = new RAGService();
        }
        return RAGService.instance;
    }

    /**
     * Ensure the service has completed initialization.
     * This must be called before any operations to guarantee all components are ready.
     */
    private async ensureInitialized(): Promise<void> {
        await this.initializationPromise;
    }

    /**
     * Initialize service components.
     * This happens automatically during construction to ensure components are never null.
     */
    private async initialize(): Promise<void> {
        try {
            logger.debug("Initializing RAGService components");

            this.dbManager = new RAGDatabaseService();
            this.embeddingProvider = await EmbeddingProviderFactory.create(undefined, {
                scope: "global",
            });
            this.operations = new RAGOperations(this.dbManager, this.embeddingProvider);

            logger.info("RAGService initialized successfully");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("RAGService initialization failed", { error: message });
            throw new Error(`Failed to initialize RAGService: ${message}`, { cause: error });
        }
    }

    /**
     * Create a new collection
     */
    public async createCollection(
        name: string,
        schema?: Partial<LanceDBSchema>
    ): Promise<RAGCollection> {
        await this.ensureInitialized();
        return this.operations.createCollection(name, schema);
    }

    /**
     * Add documents to a collection
     */
    public async addDocuments(collectionName: string, documents: RAGDocument[]): Promise<void> {
        await this.ensureInitialized();
        return this.operations.addDocuments(collectionName, documents);
    }

    /**
     * Query a collection with semantic search
     */
    public async query(
        collectionName: string,
        queryText: string,
        topK = 5
    ): Promise<RAGQueryResult[]> {
        await this.ensureInitialized();
        return this.operations.performSemanticSearch(collectionName, queryText, topK);
    }

    /**
     * Query a collection with semantic search and optional SQL filter (prefilter)
     * The filter is applied BEFORE vector search for proper project isolation
     * @param filter SQL-style filter string, e.g., "metadata LIKE '%\"projectId\":\"abc\"%'"
     */
    public async queryWithFilter(
        collectionName: string,
        queryText: string,
        topK = 5,
        filter?: string
    ): Promise<RAGQueryResult[]> {
        await this.ensureInitialized();
        return this.operations.performSemanticSearchWithFilter(collectionName, queryText, topK, filter);
    }

    /**
     * Delete a document by its ID
     */
    public async deleteDocumentById(collectionName: string, documentId: string): Promise<void> {
        await this.ensureInitialized();
        return this.operations.deleteDocumentById(collectionName, documentId);
    }

    /**
     * Delete a collection
     */
    public async deleteCollection(name: string): Promise<void> {
        await this.ensureInitialized();
        return this.operations.deleteCollection(name);
    }

    /**
     * List all collections
     */
    public async listCollections(): Promise<string[]> {
        await this.ensureInitialized();
        return this.operations.listCollections();
    }

    /**
     * Get collection statistics including document counts by agent
     */
    public async getCollectionStats(
        collectionName: string,
        agentPubkey?: string
    ): Promise<{ totalCount: number; agentCount?: number }> {
        await this.ensureInitialized();
        return this.operations.getCollectionStats(collectionName, agentPubkey);
    }

    /**
     * Get statistics for all collections with agent attribution.
     * Used by the RAG collections system prompt fragment.
     */
    public async getAllCollectionStats(
        agentPubkey: string
    ): Promise<Array<{ name: string; agentDocCount: number; totalDocCount: number }>> {
        await this.ensureInitialized();
        return this.operations.getAllCollectionStats(agentPubkey);
    }

    /**
     * Set a custom embedding provider.
     * This recreates the operations instance with the new provider.
     */
    public async setEmbeddingProvider(provider: EmbeddingProvider): Promise<void> {
        await this.ensureInitialized();

        this.embeddingProvider = provider;
        this.operations = new RAGOperations(this.dbManager, provider);

        logger.info("Embedding provider updated");
    }

    /**
     * Get current embedding provider info
     */
    public async getEmbeddingProviderInfo(): Promise<string> {
        await this.ensureInitialized();
        return this.embeddingProvider.getModelId();
    }

    /**
     * Clean up and close connections
     */
    public async close(): Promise<void> {
        await this.ensureInitialized();
        await this.dbManager.close();
        logger.debug("RAGService closed");
    }

    /**
     * Reset the singleton instance (mainly for testing)
     */
    public static resetInstance(): void {
        if (RAGService.instance) {
            RAGService.instance.close();
            RAGService.instance = null;
        }
    }
}

// Export the main types for convenience
export type { RAGDocument, RAGCollection, RAGQueryResult } from "./RAGOperations";
export { RAGValidationError, RAGOperationError } from "./RAGOperations";
export { RAGDatabaseError } from "./RAGDatabaseService";
