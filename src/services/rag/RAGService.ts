import { RAGDatabaseManager } from './RAGDatabaseManager';
import { RAGOperations } from './RAGOperations';
import { EmbeddingProviderFactory } from './EmbeddingProviderFactory';
import type { EmbeddingProvider } from '../EmbeddingProvider';
import type { RAGDocument, RAGCollection, RAGQueryResult } from './RAGOperations';
import { logger } from '@/utils/logger';

/**
 * Facade for RAG functionality
 * Coordinates between database management and operations
 */
export class RAGService {
    private static instance: RAGService | null = null;
    private dbManager: RAGDatabaseManager | null = null;
    private operations: RAGOperations | null = null;
    private embeddingProvider: EmbeddingProvider | null = null;

    private constructor() {}

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
     * Initialize the service with dependencies
     */
    private async ensureInitialized(): Promise<void> {
        if (!this.dbManager || !this.operations || !this.embeddingProvider) {
            await this.initialize();
        }
    }

    /**
     * Initialize service components
     */
    private async initialize(
        dataDir?: string,
        embeddingProvider?: EmbeddingProvider
    ): Promise<void> {
        logger.debug('Initializing RAGService components');
        
        // Initialize database manager
        this.dbManager = new RAGDatabaseManager(dataDir);
        
        // Initialize or use provided embedding provider
        this.embeddingProvider = embeddingProvider || 
            await EmbeddingProviderFactory.create();
        
        // Initialize operations with dependencies
        this.operations = new RAGOperations(
            this.dbManager,
            this.embeddingProvider
        );
        
        logger.info('RAGService initialized successfully');
    }

    /**
     * Create a new collection
     */
    public async createCollection(
        name: string, 
        schema?: Record<string, any>
    ): Promise<RAGCollection> {
        await this.ensureInitialized();
        return this.operations!.createCollection(name, schema);
    }

    /**
     * Add documents to a collection
     */
    public async addDocuments(
        collectionName: string,
        documents: RAGDocument[]
    ): Promise<void> {
        await this.ensureInitialized();
        return this.operations!.addDocuments(collectionName, documents);
    }

    /**
     * Query a collection with semantic search
     */
    public async query(
        collectionName: string,
        queryText: string,
        topK: number = 5
    ): Promise<RAGQueryResult[]> {
        await this.ensureInitialized();
        return this.operations!.performSemanticSearch(collectionName, queryText, topK);
    }

    /**
     * Delete a collection
     */
    public async deleteCollection(name: string): Promise<void> {
        await this.ensureInitialized();
        return this.operations!.deleteCollection(name);
    }

    /**
     * List all collections
     */
    public async listCollections(): Promise<string[]> {
        await this.ensureInitialized();
        return this.operations!.listCollections();
    }

    /**
     * Set a custom embedding provider
     */
    public async setEmbeddingProvider(provider: EmbeddingProvider): Promise<void> {
        await this.ensureInitialized();
        this.embeddingProvider = provider;
        
        // Recreate operations with new provider
        this.operations = new RAGOperations(
            this.dbManager!,
            provider
        );
        
        logger.info('Embedding provider updated');
    }

    /**
     * Get current embedding provider info
     */
    public async getEmbeddingProviderInfo(): Promise<string> {
        await this.ensureInitialized();
        return this.embeddingProvider!.getModelId();
    }

    /**
     * Clean up and close connections
     */
    public async close(): Promise<void> {
        if (this.dbManager) {
            await this.dbManager.close();
        }
        
        this.dbManager = null;
        this.operations = null;
        this.embeddingProvider = null;
        
        logger.debug('RAGService closed');
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
export type { RAGDocument, RAGCollection, RAGQueryResult } from './RAGOperations';
export { RAGValidationError, RAGOperationError } from './RAGOperations';
export { RAGDatabaseError } from './RAGDatabaseManager';