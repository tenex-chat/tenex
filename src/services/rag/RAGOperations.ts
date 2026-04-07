import type { DocumentMetadata } from "@/services/rag/rag-utils";
import { parseDocumentMetadata } from "@/services/rag/rag-utils";
import { AGENT_PUBKEY_KEYS } from "@/utils/metadataKeys";
import { SQL_LIKE_ESCAPE_CLAUSE, escapeSqlLikeValue } from "@/utils/sqlEscaping";
import { handleError } from "@/utils/error-handler";
import { logger } from "@/utils/logger";
import type { EmbeddingProvider } from "@/services/embedding";
import type { StoredDocument, VectorStore } from "./providers/types";

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
 * Result from bulkUpsert with per-chunk failure isolation.
 */
export interface BulkUpsertResult {
    /** Number of documents successfully upserted */
    upsertedCount: number;
    /** 0-based indices into the original input array that failed */
    failedIndices: number[];
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
    constructor(message: string, cause?: Error) {
        super(message, { cause });
        this.name = "RAGOperationError";
    }
}

/**
 * Handles RAG CRUD operations.
 * Delegates vector storage to a VectorStore provider.
 */
export class RAGOperations {
    private static readonly BATCH_SIZE = 20;

    constructor(
        private readonly vectorStore: VectorStore,
        private readonly embeddingProvider: EmbeddingProvider
    ) {}

    /**
     * Create a new collection with vector schema
     */
    async createCollection(
        name: string,
        _customSchema?: Partial<LanceDBSchema>
    ): Promise<RAGCollection> {
        this.validateCollectionName(name);

        const exists = await this.vectorStore.collectionExists(name);
        if (exists) {
            throw new RAGOperationError(`Collection '${name}' already exists`);
        }

        try {
            const dimensions = await this.embeddingProvider.getDimensions();
            await this.vectorStore.createCollection(name, dimensions);

            logger.info(`Collection '${name}' created`);

            return {
                name,
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

        try {
            for (let i = 0; i < documents.length; i += RAGOperations.BATCH_SIZE) {
                const batch = documents.slice(i, i + RAGOperations.BATCH_SIZE);
                const processedDocs = await this.processBatch(batch);
                await this.vectorStore.addDocuments(collectionName, processedDocs);

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
    private async processBatch(documents: RAGDocument[]): Promise<StoredDocument[]> {
        const results: StoredDocument[] = [];

        for (const doc of documents) {
            this.validateDocument(doc);

            const vector = doc.vector || (await this.embeddingProvider.embed(doc.content));

            results.push({
                id: doc.id || this.generateDocumentId(),
                content: doc.content,
                vector: Array.from(vector),
                metadata: JSON.stringify(doc.metadata || {}),
                timestamp: doc.timestamp || Date.now(),
                source: doc.source || "user",
            });
        }

        return results;
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
     */
    async performSemanticSearchWithFilter(
        collectionName: string,
        queryText: string,
        topK = 5,
        filter?: string
    ): Promise<RAGQueryResult[]> {
        this.validateSearchInputs(collectionName, queryText, topK);

        try {
            const queryVector = await this.embeddingProvider.embed(queryText);
            const results = await this.vectorStore.search(
                collectionName,
                Array.from(queryVector),
                topK,
                filter
            );

            logger.info(
                `Semantic search completed on '${collectionName}': found ${results.length} results`,
                { filter: filter || "none" }
            );

            return results.map((result) => ({
                document: {
                    id: result.document.id,
                    content: result.document.content,
                    metadata: parseDocumentMetadata(result.document.metadata),
                    timestamp: result.document.timestamp,
                    source: result.document.source,
                },
                score: result.score,
            }));
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
        try {
            await this.vectorStore.deleteDocument(collectionName, documentId);
            logger.debug(`Deleted document '${documentId}' from collection '${collectionName}'`);
        } catch (error) {
            logger.debug(`Could not delete document '${documentId}': ${error}`);
        }
    }

    /**
     * Delete a collection
     */
    async deleteCollection(name: string): Promise<void> {
        const exists = await this.vectorStore.collectionExists(name);
        if (!exists) {
            throw new RAGOperationError(`Collection '${name}' does not exist`);
        }

        await this.vectorStore.deleteCollection(name);
        logger.info(`Collection '${name}' deleted successfully`);
    }

    /**
     * List all collections
     */
    async listCollections(): Promise<string[]> {
        return this.vectorStore.listCollections();
    }

    /**
     * Get collection statistics including document counts by agent.
     */
    async getCollectionStats(
        collectionName: string,
        agentPubkey?: string
    ): Promise<{ totalCount: number; agentCount?: number }> {
        try {
            const totalCount = await this.vectorStore.countDocuments(collectionName);

            let agentCount: number | undefined;
            if (agentPubkey) {
                const escaped = escapeSqlLikeValue(agentPubkey);
                const clauses = AGENT_PUBKEY_KEYS
                    .map((key) => `metadata LIKE '%"${key}":"${escaped}"%' ${SQL_LIKE_ESCAPE_CLAUSE}`)
                    .join(" OR ");
                const filter = `(${clauses})`;
                agentCount = await this.vectorStore.countDocuments(collectionName, filter);
            }

            return { totalCount, agentCount };
        } catch (error) {
            return this.handleRAGError(
                error,
                `Failed to get stats for collection '${collectionName}'`
            );
        }
    }

    /**
     * Get statistics for all collections with agent attribution.
     */
    async getAllCollectionStats(
        agentPubkey: string
    ): Promise<Array<{ name: string; agentDocCount: number; totalDocCount: number }>> {
        const collections = await this.listCollections();

        const results = await Promise.allSettled(
            collections.map(async (name) => {
                const { totalCount, agentCount } = await this.getCollectionStats(name, agentPubkey);
                return {
                    name,
                    agentDocCount: agentCount ?? 0,
                    totalDocCount: totalCount,
                };
            })
        );

        return results
            .filter((r): r is PromiseFulfilledResult<{ name: string; agentDocCount: number; totalDocCount: number }> => {
                if (r.status === "rejected") {
                    logger.warn(`Failed to get stats for collection: ${r.reason}`);
                    return false;
                }
                return true;
            })
            .map(r => r.value);
    }

    /**
     * Bulk upsert documents into a collection.
     */
    async bulkUpsert(collectionName: string, documents: RAGDocument[]): Promise<BulkUpsertResult> {
        if (!documents || documents.length === 0) {
            return { upsertedCount: 0, failedIndices: [] };
        }

        let totalUpserted = 0;
        const failedIndices: number[] = [];

        for (let i = 0; i < documents.length; i += RAGOperations.BATCH_SIZE) {
            const chunkEnd = Math.min(i + RAGOperations.BATCH_SIZE, documents.length);
            const batch = documents.slice(i, chunkEnd);

            try {
                const processedDocs = await this.processBatch(batch);
                const result = await this.vectorStore.upsertDocuments(collectionName, processedDocs);
                totalUpserted += result.upsertedCount;

                // Map any provider-reported failures back to original indices
                for (const failedIdx of result.failedIndices) {
                    failedIndices.push(i + failedIdx);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.error(`Bulk upsert chunk failed (indices ${i}..${chunkEnd - 1})`, {
                    collectionName,
                    chunkSize: batch.length,
                    error: message,
                });
                for (let idx = i; idx < chunkEnd; idx++) {
                    failedIndices.push(idx);
                }
            }
        }

        logger.info(
            `Bulk upsert complete: ${totalUpserted} upserted, ${failedIndices.length} failed in '${collectionName}'`
        );

        return { upsertedCount: totalUpserted, failedIndices };
    }

    private generateDocumentId(): string {
        return `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

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

    private validateSearchInputs(collectionName: string, queryText: string, topK: number): void {
        this.validateCollectionName(collectionName);
        if (!queryText || queryText.trim().length === 0) {
            throw new RAGValidationError("Query text cannot be empty");
        }
        if (!Number.isInteger(topK) || topK < 1 || topK > 100) {
            throw new RAGValidationError("topK must be an integer between 1 and 100");
        }
    }

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

    private handleRAGError(error: unknown, message: string): never {
        if (error instanceof RAGValidationError || error instanceof RAGOperationError) {
            throw error;
        }
        handleError(error, message, { logLevel: "error" });
        throw new RAGOperationError(message, error as Error);
    }
}
