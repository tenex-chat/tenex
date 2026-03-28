import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

type MockCollectionState = Record<string, { filteredRows?: number; totalRows: number }>;

let currentVectorStore: ReturnType<typeof createMockVectorStore>;

const mockLoadVectorStoreConfig = mock(() => Promise.resolve({ provider: "mock" }));
const mockCreateEmbeddingProvider = mock(() =>
    Promise.resolve({
        embed: mock(() => Promise.resolve(new Float32Array(384))),
        embedBatch: mock(() => Promise.resolve([])),
        getDimensions: mock(() => Promise.resolve(384)),
        getModelId: mock(() => "mock-model"),
    })
);
const mockCreateVectorStore = mock(() => Promise.resolve(currentVectorStore));

mock.module("../EmbeddingProviderFactory", () => ({
    createEmbeddingProvider: mockCreateEmbeddingProvider,
    loadVectorStoreConfig: mockLoadVectorStoreConfig,
}));

mock.module("../providers", () => ({
    createVectorStore: mockCreateVectorStore,
}));

function createMockVectorStore(collections: MockCollectionState) {
    return {
        addDocuments: mock(() => Promise.resolve()),
        close: mock(() => Promise.resolve()),
        collectionExists: mock((name: string) => Promise.resolve(Boolean(collections[name]))),
        countDocuments: mock((collection: string, filter?: string) => {
            const data = collections[collection];
            if (!data) {
                return Promise.reject(new Error(`Collection '${collection}' not found`));
            }

            if (filter !== undefined && data.filteredRows !== undefined) {
                return Promise.resolve(data.filteredRows);
            }

            return Promise.resolve(data.totalRows);
        }),
        createCollection: mock((name: string) => {
            collections[name] = { totalRows: 0, filteredRows: 0 };
            return Promise.resolve();
        }),
        deleteCollection: mock((name: string) => {
            delete collections[name];
            return Promise.resolve();
        }),
        deleteDocument: mock(() => Promise.resolve()),
        getAllDocuments: mock(() => Promise.resolve([])),
        initialize: mock(() => Promise.resolve()),
        listCollections: mock(() => Promise.resolve(Object.keys(collections))),
        runMaintenance: mock(() => Promise.resolve()),
        search: mock(() => Promise.resolve([])),
        upsertDocuments: mock(() => Promise.resolve({ failedIndices: [], upsertedCount: 0 })),
    };
}

import { RAGService } from "../RAGService";

describe("RAGService cached collection stats", () => {
    beforeEach(() => {
        currentVectorStore = createMockVectorStore({
            collection1: { totalRows: 100, filteredRows: 25 },
        });
    });

    afterEach(async () => {
        await RAGService.closeInstance();
        mockLoadVectorStoreConfig.mockClear();
        mockCreateEmbeddingProvider.mockClear();
        mockCreateVectorStore.mockClear();
    });

    it("reuses cached collection stats for repeated prompt reads", async () => {
        const service = RAGService.getInstance();

        const firstStats = await service.getCachedAllCollectionStats("agent123");
        const secondStats = await service.getCachedAllCollectionStats("agent123");

        expect(firstStats).toEqual([
            { name: "collection1", agentDocCount: 25, totalDocCount: 100 },
        ]);
        expect(secondStats).toEqual(firstStats);
        expect(currentVectorStore.listCollections).toHaveBeenCalledTimes(1);
        expect(currentVectorStore.countDocuments).toHaveBeenCalledTimes(2);
    });

    it("invalidates cached collection stats after collection mutations", async () => {
        const service = RAGService.getInstance();

        await service.getCachedAllCollectionStats("agent123");
        expect(currentVectorStore.listCollections).toHaveBeenCalledTimes(1);

        await service.deleteCollection("collection1");
        const refreshedStats = await service.getCachedAllCollectionStats("agent123");

        expect(refreshedStats).toEqual([]);
        expect(currentVectorStore.listCollections).toHaveBeenCalledTimes(2);
    });
});
