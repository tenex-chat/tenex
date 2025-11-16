import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LocalTransformerEmbeddingProvider } from "../../EmbeddingProvider";
import { RAGDatabaseError, RAGDatabaseManager } from "../RAGDatabaseManager";
import { RAGOperations } from "../RAGOperations";
import { RAGOperationError, RAGService, RAGValidationError } from "../RAGService";

/**
 * Test fixture for RAG tests
 */
class RAGTestFixture {
    private tempDir: string | null = null;
    private service: RAGService | null = null;

    async setup(): Promise<{ tempDir: string; service: RAGService }> {
        // Create a unique temp directory for each test
        this.tempDir = path.join(
            os.tmpdir(),
            `rag-test-${Date.now()}-${Math.random().toString(36).substr(2)}`
        );
        fs.mkdirSync(this.tempDir, { recursive: true });

        // Set the data directory for tests
        process.env.LANCEDB_DATA_DIR = this.tempDir;

        // Reset and get service instance
        RAGService.resetInstance();
        this.service = RAGService.getInstance();

        return { tempDir: this.tempDir, service: this.service };
    }

    async teardown(): Promise<void> {
        // Close the service
        if (this.service) {
            await this.service.close();
        }

        // Clean up temp directory
        if (this.tempDir && fs.existsSync(this.tempDir)) {
            fs.rmSync(this.tempDir, { recursive: true, force: true });
        }

        // Reset environment
        delete process.env.LANCEDB_DATA_DIR;
        RAGService.resetInstance();
    }
}

describe("RAGDatabaseManager", () => {
    let fixture: RAGTestFixture;
    let dbManager: RAGDatabaseManager;

    beforeEach(async () => {
        fixture = new RAGTestFixture();
        const { tempDir } = await fixture.setup();
        dbManager = new RAGDatabaseManager(tempDir);
    });

    afterEach(async () => {
        await dbManager.close();
        await fixture.teardown();
    });

    describe("Connection Management", () => {
        it("should establish connection on first use", async () => {
            const connection = await dbManager.ensureConnection();
            expect(connection).toBeDefined();
        });

        it("should reuse existing connection", async () => {
            const conn1 = await dbManager.ensureConnection();
            const conn2 = await dbManager.ensureConnection();
            expect(conn1).toBe(conn2);
        });

        it("should handle connection errors gracefully", async () => {
            const invalidManager = new RAGDatabaseManager("/invalid/path/that/does/not/exist");
            await expect(invalidManager.ensureConnection()).rejects.toThrow(RAGDatabaseError);
        });
    });

    describe("Table Operations", () => {
        it("should create a new table", async () => {
            const table = await dbManager.createTable("test_table", [{ id: "test", value: 42 }], {
                mode: "overwrite",
            });
            expect(table).toBeDefined();

            const exists = await dbManager.tableExists("test_table");
            expect(exists).toBe(true);
        });

        it("should list tables", async () => {
            await dbManager.createTable("table1", [{ id: "1" }]);
            await dbManager.createTable("table2", [{ id: "2" }]);

            const tables = await dbManager.listTables();
            expect(tables).toContain("table1");
            expect(tables).toContain("table2");
        });

        it("should drop a table", async () => {
            await dbManager.createTable("temp_table", [{ id: "temp" }]);
            expect(await dbManager.tableExists("temp_table")).toBe(true);

            await dbManager.dropTable("temp_table");
            expect(await dbManager.tableExists("temp_table")).toBe(false);
        });

        it("should throw error when accessing non-existent table", async () => {
            await expect(dbManager.getTable("non_existent")).rejects.toThrow(
                "Collection 'non_existent' does not exist"
            );
        });
    });
});

describe("RAGOperations", () => {
    let fixture: RAGTestFixture;
    let operations: RAGOperations;
    let dbManager: RAGDatabaseManager;
    let embeddingProvider: LocalTransformerEmbeddingProvider;

    beforeEach(async () => {
        fixture = new RAGTestFixture();
        const { tempDir } = await fixture.setup();

        dbManager = new RAGDatabaseManager(tempDir);
        embeddingProvider = new LocalTransformerEmbeddingProvider();
        operations = new RAGOperations(dbManager, embeddingProvider);
    });

    afterEach(async () => {
        await dbManager.close();
        await fixture.teardown();
    });

    describe("Collection Management", () => {
        it("should validate collection names", async () => {
            await expect(operations.createCollection("invalid-name!")).rejects.toThrow(
                RAGValidationError
            );

            await expect(operations.createCollection("valid_name_123")).resolves.not.toThrow();
        });

        it("should not create duplicate collections", async () => {
            await operations.createCollection("test_collection");

            await expect(operations.createCollection("test_collection")).rejects.toThrow(
                "Collection 'test_collection' already exists"
            );
        });
    });

    describe("Document Operations", () => {
        const collectionName = "doc_test_collection";

        beforeEach(async () => {
            await operations.createCollection(collectionName);
        });

        it("should validate documents before adding", async () => {
            // Empty documents array
            await expect(operations.addDocuments(collectionName, [])).rejects.toThrow(
                "Documents array cannot be empty"
            );

            // Document with empty content
            await expect(
                operations.addDocuments(collectionName, [{ content: "   " }])
            ).rejects.toThrow("Document content cannot be empty");
        });

        it("should add documents with metadata", async () => {
            const documents = [
                {
                    content: "First document about TypeScript",
                    metadata: { language: "typescript", category: "programming" },
                },
                {
                    content: "Second document about JavaScript",
                    metadata: { language: "javascript", category: "programming" },
                },
            ];

            await expect(operations.addDocuments(collectionName, documents)).resolves.not.toThrow();
        });

        it("should handle batch processing for large document sets", async () => {
            // Create 250 documents to test batching (batch size is 100)
            const documents = Array.from({ length: 250 }, (_, i) => ({
                content: `Document number ${i} with some content`,
                metadata: { index: i },
            }));

            await expect(operations.addDocuments(collectionName, documents)).resolves.not.toThrow();
        });
    });

    describe("Semantic Search", () => {
        const collectionName = "search_test_collection";

        beforeEach(async () => {
            await operations.createCollection(collectionName);

            // Add test documents
            await operations.addDocuments(collectionName, [
                { content: "TypeScript is a typed superset of JavaScript" },
                { content: "Python is a high-level programming language" },
                { content: "Rust is a systems programming language" },
            ]);
        });

        it("should validate query parameters", async () => {
            // Empty query
            await expect(operations.performSemanticSearch(collectionName, "", 5)).rejects.toThrow(
                "Query text cannot be empty"
            );

            // Invalid topK
            await expect(
                operations.performSemanticSearch(collectionName, "test", 0)
            ).rejects.toThrow("topK must be a positive integer");

            await expect(
                operations.performSemanticSearch(collectionName, "test", -5)
            ).rejects.toThrow("topK must be a positive integer");
        });

        it("should return relevant results", async () => {
            const results = await operations.performSemanticSearch(
                collectionName,
                "What is TypeScript?",
                2
            );

            expect(results).toBeInstanceOf(Array);
            expect(results.length).toBeLessThanOrEqual(2);

            if (results.length > 0) {
                expect(results[0]).toHaveProperty("document");
                expect(results[0]).toHaveProperty("score");
                expect(results[0].score).toBeGreaterThanOrEqual(0);
                expect(results[0].score).toBeLessThanOrEqual(1);
            }
        });
    });
});

describe("RAGService (Facade)", () => {
    let fixture: RAGTestFixture;
    let service: RAGService;

    beforeEach(async () => {
        fixture = new RAGTestFixture();
        const result = await fixture.setup();
        service = result.service;
    });

    afterEach(async () => {
        await fixture.teardown();
    });

    describe("Singleton Pattern", () => {
        it("should return the same instance", () => {
            const instance1 = RAGService.getInstance();
            const instance2 = RAGService.getInstance();
            expect(instance1).toBe(instance2);
        });
    });

    describe("End-to-End Operations", () => {
        const testCollectionName = "e2e_test_collection";

        it("should complete full workflow", async () => {
            // Create collection
            const collection = await service.createCollection(testCollectionName);
            expect(collection.name).toBe(testCollectionName);

            // List collections
            let collections = await service.listCollections();
            expect(collections).toContain(testCollectionName);

            // Add documents
            await service.addDocuments(testCollectionName, [
                { content: "Node.js enables JavaScript on the server" },
                { content: "Deno is a secure runtime for JavaScript" },
                { content: "Bun is a fast JavaScript runtime" },
            ]);

            // Query documents
            const results = await service.query(testCollectionName, "JavaScript runtimes", 3);
            expect(results.length).toBeGreaterThan(0);
            expect(results.length).toBeLessThanOrEqual(3);

            // Delete collection
            await service.deleteCollection(testCollectionName);

            // Verify deletion
            collections = await service.listCollections();
            expect(collections).not.toContain(testCollectionName);
        });
    });

    describe("Error Recovery", () => {
        it("should handle operations on non-existent collections", async () => {
            await expect(
                service.addDocuments("non_existent", [{ content: "test" }])
            ).rejects.toThrow();

            await expect(service.query("non_existent", "test query")).rejects.toThrow();

            await expect(service.deleteCollection("non_existent")).rejects.toThrow();
        });
    });

    describe("Embedding Provider Management", () => {
        it("should report embedding provider info", async () => {
            const modelId = await service.getEmbeddingProviderInfo();
            expect(modelId).toBeDefined();
            expect(typeof modelId).toBe("string");
        });

        it("should allow setting custom embedding provider", async () => {
            const customProvider = new LocalTransformerEmbeddingProvider("custom/model");
            await service.setEmbeddingProvider(customProvider);

            const modelId = await service.getEmbeddingProviderInfo();
            expect(modelId).toBe("custom/model");
        });
    });
});
