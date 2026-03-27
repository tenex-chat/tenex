import { logger } from "@/utils/logger";
import type { StoredDocument, VectorSearchResult, VectorStore, VectorStoreConfig } from "./types";

/**
 * Lazy-loaded Qdrant client.
 * Optional dependency only needed when this provider is selected.
 */
let QdrantClientClass: typeof import("@qdrant/js-client-rest").QdrantClient;

async function loadDependencies(): Promise<void> {
    if (!QdrantClientClass) {
        const mod = await import("@qdrant/js-client-rest");
        QdrantClientClass = mod.QdrantClient;
    }
}

type QdrantClient = InstanceType<typeof import("@qdrant/js-client-rest").QdrantClient>;

/**
 * Qdrant implementation of the VectorStore interface.
 *
 * Connects to a Qdrant server via REST API.
 * Each collection maps 1:1 to a Qdrant collection.
 * Document fields (content, metadata, timestamp, source) are stored as payload.
 */
export class QdrantProvider implements VectorStore {
    private client: QdrantClient | null = null;
    private readonly url: string;
    private readonly apiKey?: string;

    constructor(storeConfig?: VectorStoreConfig) {
        this.url = storeConfig?.url || process.env.QDRANT_URL || "http://localhost:6333";
        this.apiKey = storeConfig?.apiKey || process.env.QDRANT_API_KEY;
    }

    async initialize(): Promise<void> {
        await loadDependencies();

        this.client = new QdrantClientClass({
            url: this.url,
            apiKey: this.apiKey,
        });

        // Verify connectivity by listing collections
        await this.client.getCollections();
        logger.info(`QdrantProvider connected to ${this.url}`);
    }

    async close(): Promise<void> {
        this.client = null;
        logger.debug("QdrantProvider closed");
    }

    // -- Collection management --

    async createCollection(name: string, dimensions: number): Promise<void> {
        const client = this.ensureClient();

        await client.createCollection(name, {
            vectors: {
                size: dimensions,
                distance: "Euclid",
            },
        });

        // Create payload indices for filterable fields
        await client.createPayloadIndex(name, {
            field_name: "metadata",
            field_schema: "text",
        });

        logger.info(`Qdrant collection '${name}' created (${dimensions} dimensions)`);
    }

    async deleteCollection(name: string): Promise<void> {
        const client = this.ensureClient();
        await client.deleteCollection(name);
        logger.info(`Qdrant collection '${name}' deleted`);
    }

    async listCollections(): Promise<string[]> {
        const client = this.ensureClient();
        const response = await client.getCollections();
        return response.collections.map((c) => c.name);
    }

    async collectionExists(name: string): Promise<boolean> {
        const client = this.ensureClient();
        try {
            await client.getCollection(name);
            return true;
        } catch {
            return false;
        }
    }

    // -- Document operations --

    async addDocuments(collection: string, documents: StoredDocument[]): Promise<void> {
        const client = this.ensureClient();

        const points = documents.map((doc) => ({
            id: doc.id,
            vector: doc.vector,
            payload: {
                content: doc.content,
                metadata: doc.metadata,
                timestamp: doc.timestamp,
                source: doc.source,
            },
        }));

        await client.upsert(collection, { points });
        logger.debug(`Added ${documents.length} documents to Qdrant collection '${collection}'`);
    }

    async upsertDocuments(
        collection: string,
        documents: StoredDocument[]
    ): Promise<{ upsertedCount: number; failedIndices: number[] }> {
        if (documents.length === 0) {
            return { upsertedCount: 0, failedIndices: [] };
        }

        const client = this.ensureClient();
        const failedIndices: number[] = [];
        let upsertedCount = 0;
        const BATCH_SIZE = 100;

        for (let i = 0; i < documents.length; i += BATCH_SIZE) {
            const chunkEnd = Math.min(i + BATCH_SIZE, documents.length);
            const batch = documents.slice(i, chunkEnd);

            try {
                const points = batch.map((doc) => ({
                    id: doc.id,
                    vector: doc.vector,
                    payload: {
                        content: doc.content,
                        metadata: doc.metadata,
                        timestamp: doc.timestamp,
                        source: doc.source,
                    },
                }));

                await client.upsert(collection, { points });
                upsertedCount += batch.length;
            } catch (error) {
                logger.error(`Qdrant upsert batch failed (indices ${i}..${chunkEnd - 1})`, {
                    error: error instanceof Error ? error.message : String(error),
                });
                for (let idx = i; idx < chunkEnd; idx++) {
                    failedIndices.push(idx);
                }
            }
        }

        return { upsertedCount, failedIndices };
    }

    async deleteDocument(collection: string, documentId: string): Promise<void> {
        const client = this.ensureClient();
        await client.delete(collection, {
            points: [documentId],
        });
        logger.debug(`Deleted document '${documentId}' from Qdrant collection '${collection}'`);
    }

    async getAllDocuments(
        collection: string,
        limit: number,
        offset: number
    ): Promise<StoredDocument[]> {
        const client = this.ensureClient();

        const response = await client.scroll(collection, {
            limit,
            offset,
            with_vector: true,
            with_payload: true,
        });

        return response.points.map((point) => ({
            id: String(point.id),
            content: (point.payload?.content as string) ?? "",
            vector: Array.from(point.vector as number[]),
            metadata: (point.payload?.metadata as string) ?? "{}",
            timestamp: (point.payload?.timestamp as number) ?? Date.now(),
            source: (point.payload?.source as string) ?? "",
        }));
    }

    // -- Search --

    async search(
        collection: string,
        vector: number[],
        topK: number,
        filter?: string
    ): Promise<VectorSearchResult[]> {
        const client = this.ensureClient();

        // Translate SQL LIKE metadata filter to Qdrant filter
        const qdrantFilter = filter ? this.translateFilter(filter) : undefined;

        const results = await client.query(collection, {
            query: vector,
            limit: topK,
            filter: qdrantFilter,
            with_payload: true,
        });

        return results.points.map((point) => ({
            document: {
                id: String(point.id),
                content: (point.payload?.content as string) ?? "",
                vector: [], // Don't return vectors in search results
                metadata: (point.payload?.metadata as string) ?? "{}",
                timestamp: (point.payload?.timestamp as number) ?? Date.now(),
                source: (point.payload?.source as string) ?? "",
            },
            // Qdrant with Euclid distance: lower distance = more similar
            // Score from query endpoint is already similarity (higher = better)
            score: Math.max(0, Math.min(1, point.score ?? 0)),
        }));
    }

    // -- Stats --

    async countDocuments(collection: string, filter?: string): Promise<number> {
        const client = this.ensureClient();

        const qdrantFilter = filter ? this.translateFilter(filter) : undefined;

        const result = await client.count(collection, {
            filter: qdrantFilter,
            exact: true,
        });

        return result.count;
    }

    // -- Maintenance --

    async runMaintenance(): Promise<void> {
        // Qdrant handles maintenance internally
        logger.debug("Qdrant maintenance: no-op (handled by server)");
    }

    // -- Internal helpers --

    private ensureClient(): QdrantClient {
        if (!this.client) {
            throw new Error("QdrantProvider not initialized. Call initialize() first.");
        }
        return this.client;
    }

    /**
     * Translate SQL-style LIKE filter on metadata to Qdrant filter format.
     *
     * Supports patterns like:
     *   metadata LIKE '%"projectId":"abc"%'
     *   (metadata LIKE '%"agent_pubkey":"x"%' OR metadata LIKE '%"agentPubkey":"x"%')
     *
     * Since metadata is stored as a string payload field in Qdrant, we use
     * the `match` condition with `text` substring matching.
     */
    private translateFilter(filter: string): Record<string, unknown> {
        // Parse OR conditions
        const orPattern = /metadata\s+LIKE\s+'%([^%]+)%'\s*(?:ESCAPE\s+'[^']*')?/gi;
        const conditions: Array<{ must: Array<{ key: string; match: { text: string } }> }> = [];

        let match: RegExpExecArray | null;
        while ((match = orPattern.exec(filter)) !== null) {
            const substring = match[1];
            conditions.push({
                must: [{ key: "metadata", match: { text: substring } }],
            });
        }

        if (conditions.length === 0) {
            return {};
        }

        if (conditions.length === 1) {
            return conditions[0];
        }

        return { should: conditions };
    }
}
