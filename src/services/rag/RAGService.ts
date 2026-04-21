import { logger } from "@/utils/logger";
import type { EmbeddingProvider } from "@/services/embedding";
import { createEmbeddingProvider } from "./EmbeddingProviderFactory";
import { loadVectorStoreConfig } from "./EmbeddingProviderFactory";
import { createVectorStore } from "./providers";
import type { VectorStore } from "./providers/types";
import { RAGOperations } from "./RAGOperations";
import type { BulkUpsertResult, RAGCollection, RAGCollectionSchema, RAGDocument, RAGQueryResult } from "./RAGOperations";

/** Default maintenance interval: 2 hours */
const MAINTENANCE_INTERVAL_MS = 2 * 60 * 60 * 1000;
const COLLECTION_STATS_CACHE_TTL_MS = 30_000;

interface CollectionStatsSnapshot {
    agentDocCount: number;
    name: string;
    totalDocCount: number;
}

interface CollectionStatsCacheEntry {
    expiresAt: number;
    stats: CollectionStatsSnapshot[];
}

/**
 * Facade for RAG functionality.
 * Coordinates between the vector store provider, embedding provider, and operations.
 */
export class RAGService {
    private static instance: RAGService | null = null;
    private vectorStore!: VectorStore;
    private operations!: RAGOperations;
    private embeddingProvider!: EmbeddingProvider;
    private maintenanceTimer: NodeJS.Timeout | null = null;
    private initializationPromise: Promise<void>;
    private cachedCollectionStats = new Map<string, CollectionStatsCacheEntry>();
    private inFlightCollectionStats = new Map<string, Promise<CollectionStatsSnapshot[]>>();

    private constructor() {
        this.initializationPromise = this.initialize();
    }

    public static getInstance(): RAGService {
        if (!RAGService.instance) {
            RAGService.instance = new RAGService();
        }
        return RAGService.instance;
    }

    private async ensureInitialized(): Promise<void> {
        await this.initializationPromise;
    }

    private async initialize(): Promise<void> {
        try {
            logger.debug("Initializing RAGService components");

            // Load vector store config and create provider
            const vectorStoreConfig = await loadVectorStoreConfig();
            this.vectorStore = await createVectorStore(vectorStoreConfig);
            await this.vectorStore.initialize();

            // Create embedding provider
            this.embeddingProvider = await createEmbeddingProvider(undefined, {
                scope: "global",
            });

            this.operations = new RAGOperations(this.vectorStore, this.embeddingProvider);

            // Schedule periodic maintenance
            this.scheduleMaintenanceRun(30_000); // First run after 30s

            logger.info("RAGService initialized successfully", {
                vectorStore: vectorStoreConfig.provider,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("RAGService initialization failed", { error: message });
            throw new Error(`Failed to initialize RAGService: ${message}`, { cause: error });
        }
    }

    private scheduleMaintenanceRun(delayMs: number): void {
        this.maintenanceTimer = setTimeout(async () => {
            try {
                await this.vectorStore.runMaintenance();
            } catch (error) {
                logger.error("Vector store maintenance failed", { error });
            } finally {
                this.scheduleMaintenanceRun(MAINTENANCE_INTERVAL_MS);
            }
        }, delayMs);
    }

    private cloneCollectionStats(
        stats: CollectionStatsSnapshot[]
    ): Array<{ name: string; agentDocCount: number; totalDocCount: number }> {
        return stats.map((entry) => ({ ...entry }));
    }

    private clearCollectionStatsCache(agentPubkey?: string): void {
        if (agentPubkey) {
            this.cachedCollectionStats.delete(agentPubkey);
            this.inFlightCollectionStats.delete(agentPubkey);
            return;
        }

        this.cachedCollectionStats.clear();
        this.inFlightCollectionStats.clear();
    }

    public async createCollection(
        name: string,
        schema?: Partial<RAGCollectionSchema>
    ): Promise<RAGCollection> {
        await this.ensureInitialized();
        const collection = await this.operations.createCollection(name, schema);
        this.clearCollectionStatsCache();
        return collection;
    }

    public async addDocuments(collectionName: string, documents: RAGDocument[]): Promise<void> {
        await this.ensureInitialized();
        await this.operations.addDocuments(collectionName, documents);
        this.clearCollectionStatsCache();
    }

    public async query(
        collectionName: string,
        queryText: string,
        topK = 5
    ): Promise<RAGQueryResult[]> {
        await this.ensureInitialized();
        return this.operations.performSemanticSearch(collectionName, queryText, topK);
    }

    public async queryWithFilter(
        collectionName: string,
        queryText: string,
        topK = 5,
        filter?: string
    ): Promise<RAGQueryResult[]> {
        await this.ensureInitialized();
        return this.operations.performSemanticSearchWithFilter(collectionName, queryText, topK, filter);
    }

    public async bulkUpsert(collectionName: string, documents: RAGDocument[]): Promise<BulkUpsertResult> {
        await this.ensureInitialized();
        const result = await this.operations.bulkUpsert(collectionName, documents);
        this.clearCollectionStatsCache();
        return result;
    }

    public async deleteDocumentById(collectionName: string, documentId: string): Promise<void> {
        await this.ensureInitialized();
        await this.operations.deleteDocumentById(collectionName, documentId);
        this.clearCollectionStatsCache();
    }

    public async deleteCollection(name: string): Promise<void> {
        await this.ensureInitialized();
        await this.operations.deleteCollection(name);
        this.clearCollectionStatsCache();
    }

    public async listCollections(): Promise<string[]> {
        await this.ensureInitialized();
        return this.operations.listCollections();
    }

    public async getCollectionStats(
        collectionName: string,
        agentPubkey?: string
    ): Promise<{ totalCount: number; agentCount?: number }> {
        await this.ensureInitialized();
        return this.operations.getCollectionStats(collectionName, agentPubkey);
    }

    public async getAllCollectionStats(
        agentPubkey: string
    ): Promise<Array<{ name: string; agentDocCount: number; totalDocCount: number }>> {
        await this.ensureInitialized();
        return this.operations.getAllCollectionStats(agentPubkey);
    }

    public async getCachedAllCollectionStats(
        agentPubkey: string
    ): Promise<Array<{ name: string; agentDocCount: number; totalDocCount: number }>> {
        await this.ensureInitialized();

        const cached = this.cachedCollectionStats.get(agentPubkey);
        if (cached && cached.expiresAt > Date.now()) {
            return this.cloneCollectionStats(cached.stats);
        }

        const inFlight = this.inFlightCollectionStats.get(agentPubkey);
        if (inFlight) {
            return this.cloneCollectionStats(await inFlight);
        }

        const loadPromise = this.operations.getAllCollectionStats(agentPubkey);
        this.inFlightCollectionStats.set(agentPubkey, loadPromise);

        try {
            const stats = await loadPromise;
            this.cachedCollectionStats.set(agentPubkey, {
                expiresAt: Date.now() + COLLECTION_STATS_CACHE_TTL_MS,
                stats: stats.map((entry) => ({ ...entry })),
            });
            return this.cloneCollectionStats(stats);
        } finally {
            const currentPromise = this.inFlightCollectionStats.get(agentPubkey);
            if (currentPromise === loadPromise) {
                this.inFlightCollectionStats.delete(agentPubkey);
            }
        }
    }

    public async setEmbeddingProvider(provider: EmbeddingProvider): Promise<void> {
        await this.ensureInitialized();
        this.embeddingProvider = provider;
        this.operations = new RAGOperations(this.vectorStore, provider);
        this.clearCollectionStatsCache();
        logger.info("Embedding provider updated");
    }

    public async getEmbeddingProviderInfo(): Promise<string> {
        await this.ensureInitialized();
        return this.embeddingProvider.getModelId();
    }

    public async getEmbeddingDimensions(): Promise<number> {
        await this.ensureInitialized();
        return this.embeddingProvider.getDimensions();
    }

    public async getCollectionDimensions(collectionName: string): Promise<number | null> {
        await this.ensureInitialized();
        return this.vectorStore.getCollectionDimensions(collectionName);
    }

    public async close(): Promise<void> {
        await this.ensureInitialized();
        if (this.maintenanceTimer) {
            clearTimeout(this.maintenanceTimer);
            this.maintenanceTimer = null;
        }
        this.clearCollectionStatsCache();
        await this.vectorStore.close();
        logger.debug("RAGService closed");
    }

    public static resetInstance(): void {
        if (RAGService.instance) {
            RAGService.instance.close();
            RAGService.instance = null;
        }
    }

    public static async closeInstance(): Promise<void> {
        if (RAGService.instance) {
            await RAGService.instance.close().catch(() => undefined);
            RAGService.instance = null;
        }
    }
}

// Export the main types for convenience
export type { BulkUpsertResult, RAGDocument, RAGCollection, RAGQueryResult } from "./RAGOperations";
export { RAGValidationError, RAGOperationError } from "./RAGOperations";
