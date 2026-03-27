import { logger } from "@/utils/logger";
import type { EmbeddingProvider } from "@/services/embedding";
import { createEmbeddingProvider } from "./EmbeddingProviderFactory";
import { loadVectorStoreConfig } from "./EmbeddingProviderFactory";
import { createVectorStore } from "./providers";
import type { VectorStore } from "./providers/types";
import { RAGOperations } from "./RAGOperations";
import type { BulkUpsertResult, LanceDBSchema, RAGCollection, RAGDocument, RAGQueryResult } from "./RAGOperations";

/** Default maintenance interval: 2 hours */
const MAINTENANCE_INTERVAL_MS = 2 * 60 * 60 * 1000;

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

    public async createCollection(
        name: string,
        schema?: Partial<LanceDBSchema>
    ): Promise<RAGCollection> {
        await this.ensureInitialized();
        return this.operations.createCollection(name, schema);
    }

    public async addDocuments(collectionName: string, documents: RAGDocument[]): Promise<void> {
        await this.ensureInitialized();
        return this.operations.addDocuments(collectionName, documents);
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
        return this.operations.bulkUpsert(collectionName, documents);
    }

    public async deleteDocumentById(collectionName: string, documentId: string): Promise<void> {
        await this.ensureInitialized();
        return this.operations.deleteDocumentById(collectionName, documentId);
    }

    public async deleteCollection(name: string): Promise<void> {
        await this.ensureInitialized();
        return this.operations.deleteCollection(name);
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

    public async setEmbeddingProvider(provider: EmbeddingProvider): Promise<void> {
        await this.ensureInitialized();
        this.embeddingProvider = provider;
        this.operations = new RAGOperations(this.vectorStore, provider);
        logger.info("Embedding provider updated");
    }

    public async getEmbeddingProviderInfo(): Promise<string> {
        await this.ensureInitialized();
        return this.embeddingProvider.getModelId();
    }

    public async close(): Promise<void> {
        await this.ensureInitialized();
        if (this.maintenanceTimer) {
            clearTimeout(this.maintenanceTimer);
            this.maintenanceTimer = null;
        }
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
