import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Table } from "@lancedb/lancedb";
import type { EmbeddingProvider } from "../../EmbeddingProvider";
import { RAGDatabaseManager } from "../RAGDatabaseManager";
import { RAGOperationError, RAGOperations, RAGValidationError } from "../RAGOperations";

// Mock dependencies
jest.mock("../RAGDatabaseManager");
jest.mock("@/utils/logger");

describe("RAGOperations", () => {
    let operations: RAGOperations;
    let mockDbManager: jest.Mocked<RAGDatabaseManager>;
    let mockEmbeddingProvider: jest.Mocked<EmbeddingProvider>;
    let mockTable: jest.Mocked<Table>;

    beforeEach(() => {
        // Setup mock database manager
        mockDbManager = new RAGDatabaseManager("/test/path") as jest.Mocked<RAGDatabaseManager>;

        // Setup mock embedding provider
        mockEmbeddingProvider = {
            embed: jest.fn(),
            getDimensions: jest.fn().mockResolvedValue(384),
            getModelName: jest.fn().mockReturnValue("test-model"),
        } as any;

        // Setup mock table
        mockTable = {
            add: jest.fn().mockResolvedValue(undefined),
            delete: jest.fn().mockResolvedValue(undefined),
            search: jest.fn(),
        } as any;

        operations = new RAGOperations(mockDbManager, mockEmbeddingProvider);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe("createCollection", () => {
        it("should create a collection with valid name", async () => {
            mockDbManager.tableExists = jest.fn().mockResolvedValue(false);
            mockDbManager.createTable = jest.fn().mockResolvedValue(mockTable);

            const result = await operations.createCollection("test_collection");

            expect(result).toMatchObject({
                name: "test_collection",
                schema: expect.objectContaining({
                    id: "string",
                    content: "string",
                    vector: "vector(384)",
                }),
            });
            expect(mockDbManager.createTable).toHaveBeenCalled();
            expect(mockTable.delete).toHaveBeenCalledWith("id = 'initial'");
        });

        it("should throw error for invalid collection names", async () => {
            const invalidNames = [
                "", // empty
                "test-collection", // hyphen
                "test collection", // space
                "test@collection", // special char
                "a".repeat(65), // too long
            ];

            for (const name of invalidNames) {
                await expect(operations.createCollection(name)).rejects.toThrow(RAGValidationError);
            }
        });

        it("should throw error if collection already exists", async () => {
            mockDbManager.tableExists = jest.fn().mockResolvedValue(true);

            await expect(operations.createCollection("existing_collection")).rejects.toThrow(
                RAGOperationError
            );
        });
    });

    describe("addDocuments", () => {
        beforeEach(() => {
            mockDbManager.getTable = jest.fn().mockResolvedValue(mockTable);
            mockEmbeddingProvider.embed = jest
                .fn()
                .mockResolvedValue(new Float32Array(384).fill(0.1));
        });

        it("should add valid documents to collection", async () => {
            const documents = [
                {
                    content: "Test document 1",
                    metadata: { type: "test" },
                },
                {
                    content: "Test document 2",
                    id: "custom_id",
                    source: "test_source",
                },
            ];

            await operations.addDocuments("test_collection", documents);

            expect(mockTable.add).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({
                        content: "Test document 1",
                        metadata: '{"type":"test"}',
                    }),
                    expect.objectContaining({
                        content: "Test document 2",
                        id: "custom_id",
                        source: "test_source",
                    }),
                ])
            );
        });

        it("should throw error for empty documents array", async () => {
            await expect(operations.addDocuments("test_collection", [])).rejects.toThrow(
                RAGValidationError
            );
        });

        it("should throw error for documents with empty content", async () => {
            const invalidDocs = [
                { content: "" },
                { content: "   " }, // whitespace only
            ];

            for (const doc of invalidDocs) {
                await expect(operations.addDocuments("test_collection", [doc])).rejects.toThrow(
                    RAGValidationError
                );
            }
        });

        it("should handle batch processing for large document sets", async () => {
            const largeDocSet = Array(250)
                .fill(null)
                .map((_, i) => ({
                    content: `Document ${i}`,
                }));

            await operations.addDocuments("test_collection", largeDocSet);

            // Should be called 3 times (100 + 100 + 50)
            expect(mockTable.add).toHaveBeenCalledTimes(3);
        });
    });

    describe("performSemanticSearch", () => {
        beforeEach(() => {
            mockDbManager.getTable = jest.fn().mockResolvedValue(mockTable);
            mockEmbeddingProvider.embed = jest
                .fn()
                .mockResolvedValue(new Float32Array(384).fill(0.1));
        });

        it("should perform search with valid inputs", async () => {
            const searchResults = [
                {
                    id: "doc1",
                    content: "Matching document",
                    metadata: '{"type":"test"}',
                    timestamp: Date.now(),
                    source: "test",
                    _distance: 0.2,
                },
            ];

            const mockSearchQuery = {
                toArray: jest.fn().mockResolvedValue(searchResults),
            };

            mockTable.search = jest.fn().mockReturnValue({
                limit: jest.fn().mockReturnValue(mockSearchQuery),
            });

            const results = await operations.performSemanticSearch(
                "test_collection",
                "search query",
                5
            );

            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({
                document: {
                    id: "doc1",
                    content: "Matching document",
                },
                score: expect.any(Number),
            });
        });

        it("should validate empty query text", async () => {
            await expect(
                operations.performSemanticSearch("test_collection", "", 5)
            ).rejects.toThrow(RAGValidationError);

            await expect(
                operations.performSemanticSearch("test_collection", "   ", 5)
            ).rejects.toThrow(RAGValidationError);
        });

        it("should validate topK parameter", async () => {
            const invalidTopKs = [0, -1, 101, 0.5, Number.NaN];

            for (const topK of invalidTopKs) {
                await expect(
                    operations.performSemanticSearch("test_collection", "query", topK)
                ).rejects.toThrow(RAGValidationError);
            }
        });

        it("should handle empty search results", async () => {
            const mockSearchQuery = {
                toArray: jest.fn().mockResolvedValue([]),
            };

            mockTable.search = jest.fn().mockReturnValue({
                limit: jest.fn().mockReturnValue(mockSearchQuery),
            });

            const results = await operations.performSemanticSearch(
                "test_collection",
                "search with no matches",
                5
            );

            expect(results).toEqual([]);
        });

        it("should handle concurrent queries", async () => {
            const mockSearchQuery = {
                toArray: jest.fn().mockResolvedValue([]),
            };

            mockTable.search = jest.fn().mockReturnValue({
                limit: jest.fn().mockReturnValue(mockSearchQuery),
            });

            // Run multiple queries concurrently
            const queries = Array(10)
                .fill(null)
                .map((_, i) =>
                    operations.performSemanticSearch("test_collection", `query ${i}`, 5)
                );

            const results = await Promise.all(queries);
            expect(results).toHaveLength(10);
            expect(mockEmbeddingProvider.embed).toHaveBeenCalledTimes(10);
        });
    });

    describe("deleteCollection", () => {
        it("should delete existing collection", async () => {
            mockDbManager.tableExists = jest.fn().mockResolvedValue(true);
            mockDbManager.dropTable = jest.fn().mockResolvedValue(undefined);

            await operations.deleteCollection("test_collection");

            expect(mockDbManager.dropTable).toHaveBeenCalledWith("test_collection");
        });

        it("should throw error if collection does not exist", async () => {
            mockDbManager.tableExists = jest.fn().mockResolvedValue(false);

            await expect(operations.deleteCollection("non_existent")).rejects.toThrow(
                RAGOperationError
            );
        });
    });

    describe("listCollections", () => {
        it("should return list of collections", async () => {
            const collections = ["collection1", "collection2", "collection3"];
            mockDbManager.listTables = jest.fn().mockResolvedValue(collections);

            const result = await operations.listCollections();

            expect(result).toEqual(collections);
            expect(mockDbManager.listTables).toHaveBeenCalled();
        });
    });

    describe("Edge Cases", () => {
        it("should handle dimension mismatch", async () => {
            mockDbManager.tableExists = jest.fn().mockResolvedValue(false);
            mockDbManager.createTable = jest
                .fn()
                .mockRejectedValue(new Error("Vector dimension mismatch"));

            await expect(operations.createCollection("test_collection")).rejects.toThrow(
                RAGOperationError
            );
        });

        it("should handle embedding generation failure", async () => {
            mockDbManager.getTable = jest.fn().mockResolvedValue(mockTable);
            mockEmbeddingProvider.embed = jest
                .fn()
                .mockRejectedValue(new Error("Embedding service unavailable"));

            await expect(
                operations.addDocuments("test_collection", [{ content: "test" }])
            ).rejects.toThrow(RAGOperationError);
        });

        it("should parse malformed metadata safely", async () => {
            const searchResults = [
                {
                    id: "doc1",
                    content: "Test",
                    metadata: "invalid json {{{",
                    timestamp: Date.now(),
                    source: "test",
                    _distance: 0.2,
                },
            ];

            const mockSearchQuery = {
                toArray: jest.fn().mockResolvedValue(searchResults),
            };

            mockTable.search = jest.fn().mockReturnValue({
                limit: jest.fn().mockReturnValue(mockSearchQuery),
            });

            mockDbManager.getTable = jest.fn().mockResolvedValue(mockTable);

            const results = await operations.performSemanticSearch("test_collection", "query", 1);

            // Should handle malformed metadata gracefully
            expect(results[0].document.metadata).toEqual({});
        });
    });
});
