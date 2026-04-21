import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

// Mock dependencies before imports
mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

mock.module("@/utils/error-handler", () => ({
    handleError: () => {},
}));

/**
 * Create a mock VectorStore with configurable countDocuments behavior.
 * The mock supports multiple collections, each with a total count
 * and an optional filtered count (returned when a filter string is passed).
 */
const createMockVectorStore = (
    collections: Record<string, { totalRows: number; filteredRows?: number }>
) => ({
    countDocuments: mock((collection: string, filter?: string) => {
        const col = collections[collection];
        if (!col) {
            return Promise.reject(new Error(`Collection '${collection}' does not exist`));
        }
        if (filter !== undefined && col.filteredRows !== undefined) {
            return Promise.resolve(col.filteredRows);
        }
        return Promise.resolve(col.totalRows);
    }),
    listCollections: mock(() => Promise.resolve(Object.keys(collections))),
    // Stubs for unused VectorStore methods
    initialize: mock(() => Promise.resolve()),
    close: mock(() => Promise.resolve()),
    createCollection: mock(() => Promise.resolve()),
    deleteCollection: mock(() => Promise.resolve()),
    collectionExists: mock(() => Promise.resolve(false)),
    addDocuments: mock(() => Promise.resolve()),
    upsertDocuments: mock(() => Promise.resolve({ upsertedCount: 0, failedIndices: [] })),
    deleteDocument: mock(() => Promise.resolve()),
    getAllDocuments: mock(() => Promise.resolve([])),
    getCollectionDimensions: mock(() => Promise.resolve(384)),
    search: mock(() => Promise.resolve([])),
    runMaintenance: mock(() => Promise.resolve()),
});

/**
 * Create a mock VectorStore where countDocuments always rejects.
 */
const createFailingMockVectorStore = (
    collections: string[],
    failingCollections: string[]
) => {
    const allCollections: Record<string, { totalRows: number; filteredRows?: number }> = {};
    for (const name of collections) {
        allCollections[name] = { totalRows: 100, filteredRows: 25 };
    }

    return {
        ...createMockVectorStore(allCollections),
        countDocuments: mock((collection: string, filter?: string) => {
            if (failingCollections.includes(collection)) {
                return Promise.reject(new Error("DB error"));
            }
            const col = allCollections[collection];
            if (filter !== undefined && col?.filteredRows !== undefined) {
                return Promise.resolve(col.filteredRows);
            }
            return Promise.resolve(col?.totalRows ?? 0);
        }),
        listCollections: mock(() => Promise.resolve(collections)),
    };
};

// Create mock embedding provider
const createMockEmbeddingProvider = () => ({
    embed: mock(() => Promise.resolve(new Float32Array(384))),
    embedBatch: mock(() => Promise.resolve([])),
    getModelId: () => "mock-model",
    getDimensions: () => 384,
});

// Import after mocks
import { RAGOperations } from "../RAGOperations";

describe("RAGOperations", () => {
    describe("getCollectionStats", () => {
        it("should return total count when no agentPubkey provided", async () => {
            const mockStore = createMockVectorStore({ test_collection: { totalRows: 100 } });
            const mockProvider = createMockEmbeddingProvider();
            const ops = new RAGOperations(mockStore as any, mockProvider as any);

            const stats = await ops.getCollectionStats("test_collection");

            expect(stats.totalCount).toBe(100);
            expect(stats.agentCount).toBeUndefined();
            expect(mockStore.countDocuments).toHaveBeenCalledTimes(1);
        });

        it("should return total and agent counts when agentPubkey provided", async () => {
            const mockStore = createMockVectorStore({
                test_collection: { totalRows: 100, filteredRows: 25 },
            });
            const mockProvider = createMockEmbeddingProvider();
            const ops = new RAGOperations(mockStore as any, mockProvider as any);

            const agentPubkey = "abc123def456";
            const stats = await ops.getCollectionStats("test_collection", agentPubkey);

            expect(stats.totalCount).toBe(100);
            expect(stats.agentCount).toBe(25);
            expect(mockStore.countDocuments).toHaveBeenCalledTimes(2);
            // Second call should have filter
            const calls = mockStore.countDocuments.mock.calls;
            expect(calls[1][1]).toContain("agent_pubkey");
            expect(calls[1][1]).toContain(agentPubkey);
        });

        it("should build correct SQL LIKE filter with ESCAPE clause", async () => {
            const mockStore = createMockVectorStore({
                test_collection: { totalRows: 100, filteredRows: 10 },
            });
            const mockProvider = createMockEmbeddingProvider();
            const ops = new RAGOperations(mockStore as any, mockProvider as any);

            await ops.getCollectionStats("test_collection", "testpubkey123");

            const calls = mockStore.countDocuments.mock.calls;
            const filter = calls[1][1];

            // Must match both "agentPubkey" (from specialized services) and "agent_pubkey" (from rag_add_documents)
            // ESCAPE clause required for DataFusion (no default escape char)
            expect(filter).toBe(
                `(metadata LIKE '%"agentPubkey":"testpubkey123"%' ESCAPE '\\\\' OR metadata LIKE '%"agent_pubkey":"testpubkey123"%' ESCAPE '\\\\')`
            );
        });
    });

    describe("getAllCollectionStats", () => {
        it("should return stats for all collections", async () => {
            const mockStore = createMockVectorStore({
                collection1: { totalRows: 100, filteredRows: 25 },
                collection2: { totalRows: 50, filteredRows: 10 },
            });
            const mockProvider = createMockEmbeddingProvider();
            const ops = new RAGOperations(mockStore as any, mockProvider as any);

            const stats = await ops.getAllCollectionStats("agent123");

            expect(stats).toHaveLength(2);
            expect(stats).toContainEqual({
                name: "collection1",
                agentDocCount: 25,
                totalDocCount: 100,
            });
            expect(stats).toContainEqual({
                name: "collection2",
                agentDocCount: 10,
                totalDocCount: 50,
            });
        });

        it("should handle empty collections list", async () => {
            const mockStore = createMockVectorStore({});
            const mockProvider = createMockEmbeddingProvider();
            const ops = new RAGOperations(mockStore as any, mockProvider as any);

            const stats = await ops.getAllCollectionStats("agent123");

            expect(stats).toHaveLength(0);
        });

        it("should skip failing collections and return partial results", async () => {
            const mockStore = createFailingMockVectorStore(
                ["collection1", "collection2"],
                ["collection2"]
            );
            const mockProvider = createMockEmbeddingProvider();
            const ops = new RAGOperations(mockStore as any, mockProvider as any);

            const stats = await ops.getAllCollectionStats("agent123");
            expect(stats).toHaveLength(1);
            expect(stats[0].name).toBe("collection1");
            expect(stats[0].totalDocCount).toBe(100);
            expect(stats[0].agentDocCount).toBe(25);
        });
    });
});
