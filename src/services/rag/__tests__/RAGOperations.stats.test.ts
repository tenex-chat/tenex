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

// Create mock table with configurable behavior
const createMockTable = (options: {
    totalRows: number;
    filteredRows?: number;
}) => ({
    countRows: mock((filter?: string) => {
        if (filter !== undefined && options.filteredRows !== undefined) {
            return Promise.resolve(options.filteredRows);
        }
        return Promise.resolve(options.totalRows);
    }),
});

// Create mock database manager
const createMockDbManager = (tables: Record<string, ReturnType<typeof createMockTable>>) => ({
    getTable: mock((name: string) => {
        const table = tables[name];
        if (!table) {
            return Promise.reject(new Error(`Collection '${name}' does not exist`));
        }
        return Promise.resolve(table);
    }),
    listTables: mock(() => Promise.resolve(Object.keys(tables))),
});

// Create mock embedding provider
const createMockEmbeddingProvider = () => ({
    embed: mock(() => Promise.resolve(new Float32Array(384))),
    getModelId: () => "mock-model",
    getDimensions: () => 384,
});

// Import after mocks
import { RAGOperations } from "../RAGOperations";
import { escapeSqlLikeValue } from "@/utils/sqlEscaping";

describe("RAGOperations", () => {
    describe("getCollectionStats", () => {
        it("should return total count when no agentPubkey provided", async () => {
            const mockTable = createMockTable({ totalRows: 100 });
            const mockDbManager = createMockDbManager({ test_collection: mockTable });
            const mockProvider = createMockEmbeddingProvider();
            const ops = new RAGOperations(mockDbManager as any, mockProvider as any);

            const stats = await ops.getCollectionStats("test_collection");

            expect(stats.totalCount).toBe(100);
            expect(stats.agentCount).toBeUndefined();
            expect(mockTable.countRows).toHaveBeenCalledTimes(1);
            expect(mockTable.countRows).toHaveBeenCalledWith();
        });

        it("should return total and agent counts when agentPubkey provided", async () => {
            const mockTable = createMockTable({ totalRows: 100, filteredRows: 25 });
            const mockDbManager = createMockDbManager({ test_collection: mockTable });
            const mockProvider = createMockEmbeddingProvider();
            const ops = new RAGOperations(mockDbManager as any, mockProvider as any);

            const agentPubkey = "abc123def456";
            const stats = await ops.getCollectionStats("test_collection", agentPubkey);

            expect(stats.totalCount).toBe(100);
            expect(stats.agentCount).toBe(25);
            expect(mockTable.countRows).toHaveBeenCalledTimes(2);
            // Second call should have filter
            const calls = mockTable.countRows.mock.calls;
            expect(calls[1][0]).toContain("agent_pubkey");
            expect(calls[1][0]).toContain(agentPubkey);
        });

        it("should build correct SQL LIKE filter with ESCAPE clause", async () => {
            const mockTable = createMockTable({ totalRows: 100, filteredRows: 10 });
            const mockDbManager = createMockDbManager({ test_collection: mockTable });
            const mockProvider = createMockEmbeddingProvider();
            const ops = new RAGOperations(mockDbManager as any, mockProvider as any);

            await ops.getCollectionStats("test_collection", "testpubkey123");

            const calls = mockTable.countRows.mock.calls;
            const filter = calls[1][0];
            
            // Must match both "agentPubkey" (from specialized services) and "agent_pubkey" (from rag_add_documents)
            // ESCAPE clause required for DataFusion (no default escape char)
            expect(filter).toBe(
                `(metadata LIKE '%"agentPubkey":"testpubkey123"%' ESCAPE '\\\\' OR metadata LIKE '%"agent_pubkey":"testpubkey123"%' ESCAPE '\\\\')`
            );
        });
    });

    describe("getAllCollectionStats", () => {
        it("should return stats for all collections", async () => {
            const mockTable1 = createMockTable({ totalRows: 100, filteredRows: 25 });
            const mockTable2 = createMockTable({ totalRows: 50, filteredRows: 10 });
            const mockDbManager = createMockDbManager({
                collection1: mockTable1,
                collection2: mockTable2,
            });
            const mockProvider = createMockEmbeddingProvider();
            const ops = new RAGOperations(mockDbManager as any, mockProvider as any);

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
            const mockDbManager = createMockDbManager({});
            const mockProvider = createMockEmbeddingProvider();
            const ops = new RAGOperations(mockDbManager as any, mockProvider as any);

            const stats = await ops.getAllCollectionStats("agent123");

            expect(stats).toHaveLength(0);
        });

        it("should propagate errors from individual collections", async () => {
            const mockTable1 = createMockTable({ totalRows: 100, filteredRows: 25 });
            // Table2 throws an error
            const mockTable2 = {
                countRows: mock(() => Promise.reject(new Error("DB error"))),
            };
            const mockDbManager = createMockDbManager({
                collection1: mockTable1,
                collection2: mockTable2 as any,
            });
            const mockProvider = createMockEmbeddingProvider();
            const ops = new RAGOperations(mockDbManager as any, mockProvider as any);

            // Errors from individual collections now propagate through Promise.all
            await expect(ops.getAllCollectionStats("agent123")).rejects.toThrow();
        });
    });
});

describe("escapeSqlLikeValue (shared utility)", () => {
    it("should escape double quotes", () => {
        expect(escapeSqlLikeValue('test"value')).toBe('test\\"value');
    });

    it("should escape single quotes by doubling", () => {
        expect(escapeSqlLikeValue("test'value")).toBe("test''value");
    });

    it("should escape backslashes", () => {
        expect(escapeSqlLikeValue("test\\value")).toBe("test\\\\value");
    });

    it("should escape LIKE wildcards", () => {
        expect(escapeSqlLikeValue("test%value")).toBe("test\\%value");
        expect(escapeSqlLikeValue("test_value")).toBe("test\\_value");
    });

    it("should handle hex pubkeys (no escaping needed)", () => {
        const hexPubkey = "a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd";
        expect(escapeSqlLikeValue(hexPubkey)).toBe(hexPubkey);
    });
});
