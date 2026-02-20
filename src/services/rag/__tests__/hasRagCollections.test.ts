import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";

// Mock dependencies before imports
mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

// Track mock state
let mockListTablesResult: string[] = [];
let mockListTablesError: Error | null = null;
let mockCloseError: Error | null = null;
let listTablesCalled = false;
let closeCalled = false;

mock.module("../RAGDatabaseService", () => ({
    RAGDatabaseService: class {
        async listTables(): Promise<string[]> {
            listTablesCalled = true;
            if (mockListTablesError) {
                throw mockListTablesError;
            }
            return mockListTablesResult;
        }
        async close(): Promise<void> {
            closeCalled = true;
            if (mockCloseError) {
                throw mockCloseError;
            }
        }
    },
}));

// Import after mocks
import { hasRagCollections } from "../RAGService";

describe("hasRagCollections", () => {
    beforeEach(() => {
        mockListTablesResult = [];
        mockListTablesError = null;
        mockCloseError = null;
        listTablesCalled = false;
        closeCalled = false;
    });

    it("should return false when no collections exist", async () => {
        mockListTablesResult = [];

        const result = await hasRagCollections();

        expect(result).toBe(false);
        expect(listTablesCalled).toBe(true);
        expect(closeCalled).toBe(true);
    });

    it("should return true when collections exist", async () => {
        mockListTablesResult = ["collection1", "collection2"];

        const result = await hasRagCollections();

        expect(result).toBe(true);
        expect(listTablesCalled).toBe(true);
        expect(closeCalled).toBe(true);
    });

    it("should return true for single collection", async () => {
        mockListTablesResult = ["single_collection"];

        const result = await hasRagCollections();

        expect(result).toBe(true);
    });

    it("should return false when database throws error", async () => {
        mockListTablesError = new Error("Database not found");

        const result = await hasRagCollections();

        expect(result).toBe(false);
    });

    it("should always close the database connection", async () => {
        mockListTablesResult = ["collection"];

        await hasRagCollections();

        expect(closeCalled).toBe(true);
    });

    it("should handle close errors gracefully", async () => {
        mockListTablesResult = ["collection"];
        mockCloseError = new Error("Close failed");

        // Should not throw, and should return based on table list result
        // Close errors are caught in the finally block and only logged
        const result = await hasRagCollections();

        // The close error doesn't affect the return value - we already got the table list
        expect(result).toBe(true);
    });
});
