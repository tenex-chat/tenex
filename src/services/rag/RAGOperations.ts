import type { Table } from '@lancedb/lancedb';
import type { RAGDatabaseManager } from './RAGDatabaseManager';
import type { EmbeddingProvider } from '../EmbeddingProvider';
import { logger } from '@/utils/logger';
import { handleError } from '@/utils/error-handler';
import { 
    mapLanceResultToDocument, 
    calculateRelevanceScore,
    parseDocumentMetadata 
} from '@/tools/utils';

/**
 * Document structure for RAG operations
 */
export interface RAGDocument {
    id?: string;
    content: string;
    metadata?: Record<string, any>;
    vector?: Float32Array;
    timestamp?: number;
    source?: string;
}

/**
 * Collection metadata structure
 */
export interface RAGCollection {
    name: string;
    schema?: Record<string, any>;
    created_at: number;
    updated_at: number;
}

/**
 * Query result with relevance score
 */
export interface RAGQueryResult {
    document: RAGDocument;
    score: number;
}

/**
 * Custom errors for RAG operations
 */
export class RAGValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RAGValidationError';
    }
}

export class RAGOperationError extends Error {
    constructor(message: string, public readonly cause?: Error) {
        super(message);
        this.name = 'RAGOperationError';
    }
}

/**
 * Handles RAG CRUD operations
 * Single Responsibility: Business logic for document storage and retrieval
 */
export class RAGOperations {
    private static readonly BATCH_SIZE = 100;
    
    constructor(
        private readonly dbManager: RAGDatabaseManager,
        private readonly embeddingProvider: EmbeddingProvider
    ) {}

    /**
     * Create a new collection with vector schema
     */
    async createCollection(name: string, customSchema?: Record<string, any>): Promise<RAGCollection> {
        // Validate collection name
        this.validateCollectionName(name);

        // Check if already exists
        const exists = await this.dbManager.tableExists(name);
        if (exists) {
            throw new RAGOperationError(`Collection '${name}' already exists`);
        }

        try {
            const dimensions = await this.embeddingProvider.getDimensions();
            
            // Build schema with vector column
            const defaultSchema = {
                id: 'string',
                content: 'string',
                vector: `vector(${dimensions})`,
                metadata: 'string', // JSON string
                timestamp: 'int64',
                source: 'string'
            };

            const finalSchema = { ...defaultSchema, ...customSchema };

            // Create table with initial row (required by LanceDB)
            // Use regular array for vector to match document insertion format
            const initialRow = {
                id: 'initial',
                content: '',
                vector: Array(dimensions).fill(0),
                metadata: '{}',
                timestamp: Date.now(),
                source: 'system'
            };

            const table = await this.dbManager.createTable(
                name,
                [initialRow],
                { mode: 'overwrite' }
            );

            // Delete the initial row
            await table.delete("id = 'initial'");

            logger.info(`Collection '${name}' created with schema`, { schema: finalSchema });

            return {
                name,
                schema: finalSchema,
                created_at: Date.now(),
                updated_at: Date.now()
            };
        } catch (error) {
            if (error instanceof RAGValidationError || error instanceof RAGOperationError) {
                throw error;
            }
            const message = `Failed to create collection '${name}'`;
            handleError(error, message, { logLevel: 'error' });
            throw new RAGOperationError(message, error as Error);
        }
    }

    /**
     * Add documents to a collection with batching
     */
    async addDocuments(collectionName: string, documents: RAGDocument[]): Promise<void> {
        if (!documents || documents.length === 0) {
            throw new RAGValidationError('Documents array cannot be empty');
        }

        const table = await this.dbManager.getTable(collectionName);

        try {
            // Process in batches for efficiency
            for (let i = 0; i < documents.length; i += RAGOperations.BATCH_SIZE) {
                const batch = documents.slice(i, i + RAGOperations.BATCH_SIZE);
                
                const processedDocs = await this.processBatch(batch);
                await table.add(processedDocs);
                
                logger.debug(
                    `Added batch of ${processedDocs.length} documents to '${collectionName}'`
                );
            }

            logger.info(
                `Successfully added ${documents.length} documents to collection '${collectionName}'`
            );
        } catch (error) {
            const message = `Failed to add documents to collection '${collectionName}'`;
            handleError(error, message, { logLevel: 'error' });
            throw new RAGOperationError(message, error as Error);
        }
    }

    /**
     * Process a batch of documents for insertion
     */
    private async processBatch(documents: RAGDocument[]): Promise<any[]> {
        return Promise.all(
            documents.map(async (doc) => {
                // Validate document structure
                this.validateDocument(doc);

                const vector = doc.vector || await this.embeddingProvider.embed(doc.content);
                
                return {
                    id: doc.id || this.generateDocumentId(),
                    content: doc.content,
                    vector: Array.from(vector), // Convert Float32Array to array for LanceDB
                    metadata: JSON.stringify(doc.metadata || {}),
                    timestamp: doc.timestamp || Date.now(),
                    source: doc.source || 'user'
                };
            })
        );
    }

    /**
     * Perform semantic search on a collection
     */
    async performSemanticSearch(
        collectionName: string,
        queryText: string,
        topK: number = 5
    ): Promise<RAGQueryResult[]> {
        // Validate inputs early
        this.validateSearchInputs(collectionName, queryText, topK);

        const table = await this.dbManager.getTable(collectionName);

        try {
            // Generate query embedding
            const queryVector = await this.embeddingProvider.embed(queryText);

            // Perform vector search
            const results = await this.executeVectorSearch(
                table,
                queryVector,
                topK
            );

            logger.info(
                `Semantic search completed on '${collectionName}': found ${results.length} results`
            );

            return results;
        } catch (error) {
            if (error instanceof RAGValidationError) {
                throw error;
            }
            const message = `Failed to perform semantic search on collection '${collectionName}'`;
            handleError(error, message, { logLevel: 'error' });
            throw new RAGOperationError(message, error as Error);
        }
    }

    /**
     * Execute vector search and transform results
     */
    private async executeVectorSearch(
        table: Table,
        queryVector: Float32Array,
        topK: number
    ): Promise<RAGQueryResult[]> {
        const searchQuery = this.createVectorSearchQuery(table, queryVector, topK);
        const results = await this.executeLanceDBQuery(searchQuery);
        return this.transformSearchResults(results);
    }

    /**
     * Create a vector search query
     */
    private createVectorSearchQuery(
        table: Table, 
        queryVector: Float32Array, 
        topK: number
    ): any {
        logger.debug(`Creating vector search with topK=${topK}, vector_dims=${queryVector.length}`);
        return table.search(Array.from(queryVector)).limit(topK);
    }

    /**
     * Execute LanceDB query with fallback approaches
     */
    private async executeLanceDBQuery(searchQuery: any): Promise<any[]> {
        const results: any[] = [];
        
        try {
            if (typeof searchQuery.toArray === 'function') {
                const queryResults = await searchQuery.toArray();
                logger.debug(`Query executed with toArray(), got ${queryResults.length} results`);
                results.push(...queryResults);
            } else {
                await this.executeQueryFallback(searchQuery, results);
            }
        } catch (error) {
            logger.error('Failed to execute vector search', { error });
            throw new Error(`Vector search execution failed: ${error}`);
        }
        
        this.logQueryResults(results);
        return results;
    }

    /**
     * Fallback execution methods for LanceDB query
     */
    private async executeQueryFallback(searchQuery: any, results: any[]): Promise<void> {
        if (typeof searchQuery.execute === 'function') {
            const queryResults = await searchQuery.execute();
            logger.debug(`Query executed with execute()`);
            
            if (Array.isArray(queryResults)) {
                results.push(...queryResults);
            } else if (queryResults) {
                for await (const item of queryResults) {
                    results.push(item);
                }
            }
        } else {
            logger.debug(`No toArray() or execute(), trying direct iteration`);
            for await (const item of searchQuery) {
                results.push(item);
            }
        }
    }

    /**
     * Log query results for debugging
     */
    private logQueryResults(results: any[]): void {
        logger.debug(`Vector search collected ${results.length} results`);
        
        if (results.length > 0) {
            logger.debug(`First result structure: ${JSON.stringify(Object.keys(results[0]))}`);
            logger.debug(`First result sample:`, {
                id: results[0].id,
                content_preview: results[0].content?.substring(0, 50),
                has_vector: !!results[0].vector,
                distance: results[0]._distance
            });
        }
    }

    /**
     * Transform LanceDB results to RAGQueryResult format
     */
    private transformSearchResults(results: any[]): RAGQueryResult[] {
        return results.map(result => this.transformSingleResult(result));
    }

    /**
     * Transform a single LanceDB result
     */
    private transformSingleResult(result: any): RAGQueryResult {
        return {
            document: mapLanceResultToDocument(result),
            score: calculateRelevanceScore(result._distance)
        };
    }

    /**
     * Delete a collection
     */
    async deleteCollection(name: string): Promise<void> {
        const exists = await this.dbManager.tableExists(name);
        if (!exists) {
            throw new RAGOperationError(`Collection '${name}' does not exist`);
        }

        await this.dbManager.dropTable(name);
        logger.info(`Collection '${name}' deleted successfully`);
    }

    /**
     * List all collections
     */
    async listCollections(): Promise<string[]> {
        return this.dbManager.listTables();
    }

    /**
     * Generate a unique document ID
     */
    private generateDocumentId(): string {
        return `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Validate collection name format
     */
    private validateCollectionName(name: string): void {
        if (!name || typeof name !== 'string') {
            throw new RAGValidationError('Collection name must be a non-empty string');
        }
        
        if (!/^[a-zA-Z0-9_]+$/.test(name)) {
            throw new RAGValidationError(
                'Collection name must be alphanumeric with underscores only'
            );
        }
        
        if (name.length > 64) {
            throw new RAGValidationError('Collection name must be 64 characters or less');
        }
    }

    /**
     * Validate search input parameters
     */
    private validateSearchInputs(
        collectionName: string, 
        queryText: string, 
        topK: number
    ): void {
        this.validateCollectionName(collectionName);
        
        if (!queryText || queryText.trim().length === 0) {
            throw new RAGValidationError('Query text cannot be empty');
        }
        
        if (!Number.isInteger(topK) || topK < 1 || topK > 100) {
            throw new RAGValidationError('topK must be an integer between 1 and 100');
        }
    }

    /**
     * Validate document structure
     */
    private validateDocument(doc: RAGDocument): void {
        if (!doc.content || doc.content.trim().length === 0) {
            throw new RAGValidationError('Document content cannot be empty');
        }
        
        if (doc.id && typeof doc.id !== 'string') {
            throw new RAGValidationError('Document ID must be a string');
        }
        
        if (doc.metadata && typeof doc.metadata !== 'object') {
            throw new RAGValidationError('Document metadata must be an object');
        }
    }
}