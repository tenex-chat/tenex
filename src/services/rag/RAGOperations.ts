import type { DocumentMetadata, LanceDBResult, LanceDBStoredDocument } from "@/services/rag/rag-utils";
import { calculateRelevanceScore, mapLanceResultToDocument } from "@/services/rag/rag-utils";
import { handleError } from "@/utils/error-handler";
import { logger } from "@/utils/logger";
import type { Table, VectorQuery } from "@lancedb/lancedb";
import type { EmbeddingProvider } from "@/services/embedding";
import type { RAGDatabaseService } from "./RAGDatabaseService";

/**
 * Document structure for RAG operations
 */
export interface RAGDocument {
    id?: string;
    content: string;
    metadata?: DocumentMetadata;
    vector?: Float32Array;
    timestamp?: number;
    source?: string;
}

/**
 * Schema definition for LanceDB collection
 */
export interface LanceDBSchema {
    id: string;
    content: string;
    vector: string;
    metadata: string;
    timestamp: string;
    source: string;
    [key: string]: string;
}

/**
 * Collection metadata structure
 */
export interface RAGCollection {
    name: string;
    schema?: LanceDBSchema;
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
        this.name = "RAGValidationError";
    }
}

export class RAGOperationError extends Error {
    constructor(
        message: string,
        public readonly cause?: Error
    ) {
        super(message);
        this.name = "RAGOperationError";
    }
}

/**
 * Handles RAG CRUD operations
 * Single Responsibility: Business logic for document storage and retrieval
 */
export class RAGOperations {
    private static readonly BATCH_SIZE = 100;

    constructor(
        private readonly dbManager: RAGDatabaseService,
        private readonly embeddingProvider: EmbeddingProvider
    ) {}

    /**
     * Create a new collection with vector schema
     */
    async createCollection(
        name: string,
        customSchema?: Partial<LanceDBSchema>
    ): Promise<RAGCollection> {
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
                id: "string",
                content: "string",
                vector: `vector(${dimensions})`,
                metadata: "string", // JSON string
                timestamp: "int64",
                source: "string",
            };

            const finalSchema = { ...defaultSchema, ...customSchema };

            // Create table with initial row (required by LanceDB)
            // Use regular array for vector to match document insertion format
            const initialRow = {
                id: "initial",
                content: "",
                vector: Array(dimensions).fill(0),
                metadata: "{}",
                timestamp: Date.now(),
                source: "system",
            };

            const table = await this.dbManager.createTable(name, [initialRow], {
                mode: "overwrite",
            });

            // Delete the initial row
            await table.delete("id = 'initial'");

            logger.info(`Collection '${name}' created with schema`, { schema: finalSchema });

            return {
                name,
                schema: finalSchema,
                created_at: Date.now(),
                updated_at: Date.now(),
            };
        } catch (error) {
            return this.handleRAGError(error, `Failed to create collection '${name}'`);
        }
    }

    /**
     * Add documents to a collection with batching
     */
    async addDocuments(collectionName: string, documents: RAGDocument[]): Promise<void> {
        if (!documents || documents.length === 0) {
            throw new RAGValidationError("Documents array cannot be empty");
        }

        const table = await this.dbManager.getTable(collectionName);

        try {
            // Process in batches for efficiency
            for (let i = 0; i < documents.length; i += RAGOperations.BATCH_SIZE) {
                const batch = documents.slice(i, i + RAGOperations.BATCH_SIZE);

                const processedDocs = await this.processBatch(batch);
                await table.add(processedDocs as unknown as Record<string, unknown>[]);

                logger.debug(
                    `Added batch of ${processedDocs.length} documents to '${collectionName}'`
                );
            }

            logger.info(
                `Successfully added ${documents.length} documents to collection '${collectionName}'`
            );
        } catch (error) {
            return this.handleRAGError(
                error,
                `Failed to add documents to collection '${collectionName}'`
            );
        }
    }

    /**
     * Process a batch of documents for insertion
     */
    private async processBatch(documents: RAGDocument[]): Promise<LanceDBStoredDocument[]> {
        return Promise.all(
            documents.map(async (doc) => {
                // Validate document structure
                this.validateDocument(doc);

                const vector = doc.vector || (await this.embeddingProvider.embed(doc.content));

                const storedDoc: LanceDBStoredDocument = {
                    id: doc.id || this.generateDocumentId(),
                    content: doc.content,
                    vector: Array.from(vector),
                    metadata: JSON.stringify(doc.metadata || {}),
                    timestamp: doc.timestamp || Date.now(),
                    source: doc.source || "user",
                };

                return storedDoc;
            })
        );
    }

    /**
     * Perform semantic search on a collection
     */
    async performSemanticSearch(
        collectionName: string,
        queryText: string,
        topK = 5
    ): Promise<RAGQueryResult[]> {
        return this.performSemanticSearchWithFilter(collectionName, queryText, topK, undefined);
    }

    /**
     * Perform semantic search with optional SQL prefilter
     * The filter is applied BEFORE vector search for proper isolation
     * @param filter SQL-style filter string, applied as prefilter during vector search
     */
    async performSemanticSearchWithFilter(
        collectionName: string,
        queryText: string,
        topK = 5,
        filter?: string
    ): Promise<RAGQueryResult[]> {
        // Validate inputs early
        this.validateSearchInputs(collectionName, queryText, topK);

        const table = await this.dbManager.getTable(collectionName);

        try {
            // Generate query embedding
            const queryVector = await this.embeddingProvider.embed(queryText);

            // Perform vector search with optional filter
            const results = await this.executeVectorSearch(table, queryVector, topK, filter);

            logger.info(
                `Semantic search completed on '${collectionName}': found ${results.length} results`,
                { filter: filter || "none" }
            );

            return results;
        } catch (error) {
            return this.handleRAGError(
                error,
                `Failed to perform semantic search on collection '${collectionName}'`
            );
        }
    }

    /**
     * Delete a document by its ID
     */
    async deleteDocumentById(collectionName: string, documentId: string): Promise<void> {
        const table = await this.dbManager.getTable(collectionName);

        try {
            // Escape single quotes in the ID for SQL safety
            const escapedId = documentId.replace(/'/g, "''");
            await table.delete(`id = '${escapedId}'`);
            logger.debug(`Deleted document '${documentId}' from collection '${collectionName}'`);
        } catch (error) {
            // Log but don't throw - document might not exist
            logger.debug(`Could not delete document '${documentId}': ${error}`);
        }
    }

    /**
     * Execute vector search with optional prefilter and transform results
     */
    private async executeVectorSearch(
        table: Table,
        queryVector: Float32Array,
        topK: number,
        filter?: string
    ): Promise<RAGQueryResult[]> {
        const searchQuery = this.createVectorSearchQuery(table, queryVector, topK, filter);
        const results = await this.executeLanceDBQuery(searchQuery);
        return this.transformSearchResults(results);
    }

    /**
     * Create a vector search query with optional SQL prefilter
     * The filter is applied BEFORE vector search (prefilter by default in LanceDB)
     */
    private createVectorSearchQuery(
        table: Table,
        queryVector: Float32Array,
        topK: number,
        filter?: string
    ): VectorQuery {
        logger.debug(`Creating vector search with topK=${topK}, vector_dims=${queryVector.length}, filter=${filter || "none"}`);

        let query = table.search(Array.from(queryVector)).limit(topK) as VectorQuery;

        // Apply prefilter if provided - this filters BEFORE vector search
        if (filter) {
            query = query.where(filter) as VectorQuery;
        }

        return query;
    }

    /**
     * Execute LanceDB query with fallback approaches
     */
    private async executeLanceDBQuery(searchQuery: VectorQuery): Promise<LanceDBResult[]> {
        return this.withQueryErrorHandling(async () => {
            const results =
                (await this.tryToArrayQuery(searchQuery)) ??
                (await this.tryExecuteQuery(searchQuery)) ??
                (await this.tryIterateQuery(searchQuery));

            this.logQueryResults(results);
            return results;
        }, "Vector search execution failed");
    }

    /**
     * Try executing query using toArray() method
     */
    private async tryToArrayQuery(searchQuery: VectorQuery): Promise<LanceDBResult[] | null> {
        if (typeof searchQuery.toArray !== "function") return null;

        const queryResults = await searchQuery.toArray();
        logger.debug(`Query executed with toArray(), got ${queryResults.length} results`);
        return queryResults;
    }

    /**
     * Try executing query using execute() method
     */
    private async tryExecuteQuery(searchQuery: VectorQuery): Promise<LanceDBResult[] | null> {
        const queryWithExecute = searchQuery as VectorQuery & { execute?: () => Promise<unknown> };
        if (typeof queryWithExecute.execute !== "function") return null;

        const queryResults = await queryWithExecute.execute();
        logger.debug("Query executed with execute()");

        if (Array.isArray(queryResults)) {
            return queryResults;
        }

        if (queryResults) {
            const results: LanceDBResult[] = [];
            for await (const item of queryResults) {
                results.push(item as unknown as LanceDBResult);
            }
            return results;
        }

        return null;
    }

    /**
     * Try executing query using direct iteration
     */
    private async tryIterateQuery(searchQuery: VectorQuery): Promise<LanceDBResult[]> {
        logger.debug("Trying direct iteration");
        const results: LanceDBResult[] = [];

        for await (const item of searchQuery) {
            results.push(item as unknown as LanceDBResult);
        }

        return results;
    }

    /**
     * Higher-order function for consistent error handling in query operations
     */
    private async withQueryErrorHandling<T>(
        operation: () => Promise<T>,
        errorMessage: string
    ): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            logger.error(errorMessage, { error });
            throw new Error(`${errorMessage}: ${error}`);
        }
    }

    /**
     * Centralized error handling for RAG operations
     * Preserves validation/operation errors, wraps others in RAGOperationError
     */
    private handleRAGError(error: unknown, message: string): never {
        if (error instanceof RAGValidationError || error instanceof RAGOperationError) {
            throw error;
        }
        handleError(error, message, { logLevel: "error" });
        throw new RAGOperationError(message, error as Error);
    }

    /**
     * Log query results for debugging
     */
    private logQueryResults(results: LanceDBResult[]): void {
        logger.debug(`Vector search collected ${results.length} results`);

        if (results.length > 0) {
            logger.debug(`First result structure: ${JSON.stringify(Object.keys(results[0]))}`);
            logger.debug("First result sample:", {
                id: results[0].id,
                content_preview: results[0].content?.substring(0, 50),
                has_vector: !!results[0].vector,
                distance: results[0]._distance,
            });
        }
    }

    /**
     * Transform LanceDB results to RAGQueryResult format
     */
    private transformSearchResults(results: LanceDBResult[]): RAGQueryResult[] {
        return results.map((result) => this.transformSingleResult(result));
    }

    /**
     * Transform a single LanceDB result
     */
    private transformSingleResult(result: LanceDBResult): RAGQueryResult {
        return {
            document: mapLanceResultToDocument(result),
            score: calculateRelevanceScore(result._distance),
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
        if (!name || typeof name !== "string") {
            throw new RAGValidationError("Collection name must be a non-empty string");
        }

        if (!/^[a-zA-Z0-9_]+$/.test(name)) {
            throw new RAGValidationError(
                "Collection name must be alphanumeric with underscores only"
            );
        }

        if (name.length > 64) {
            throw new RAGValidationError("Collection name must be 64 characters or less");
        }
    }

    /**
     * Validate search input parameters
     */
    private validateSearchInputs(collectionName: string, queryText: string, topK: number): void {
        this.validateCollectionName(collectionName);

        if (!queryText || queryText.trim().length === 0) {
            throw new RAGValidationError("Query text cannot be empty");
        }

        if (!Number.isInteger(topK) || topK < 1 || topK > 100) {
            throw new RAGValidationError("topK must be an integer between 1 and 100");
        }
    }

    /**
     * Validate document structure
     */
    private validateDocument(doc: RAGDocument): void {
        if (!doc.content || doc.content.trim().length === 0) {
            throw new RAGValidationError("Document content cannot be empty");
        }

        if (doc.id && typeof doc.id !== "string") {
            throw new RAGValidationError("Document ID must be a string");
        }

        if (doc.metadata && typeof doc.metadata !== "object") {
            throw new RAGValidationError("Document metadata must be an object");
        }
    }
}
