import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

// Mock ConfigService
let mockSearchModelName: string | undefined;
let mockCreateLLMServiceResult: any;

mock.module("@/services/ConfigService", () => ({
    config: {
        getSearchModelName: () => mockSearchModelName,
        createLLMService: () => mockCreateLLMServiceResult,
    },
}));

// Mock RAGService for dynamic collection discovery
let mockListCollections: () => Promise<string[]> = async () => [];
let mockQueryWithFilter: (name: string, query: string, topK: number, filter?: string) => Promise<any[]> =
    async () => [];

mock.module("@/services/rag/RAGService", () => ({
    RAGService: {
        getInstance: () => ({
            listCollections: () => mockListCollections(),
            queryWithFilter: (name: string, query: string, topK: number, filter?: string) =>
                mockQueryWithFilter(name, query, topK, filter),
        }),
    },
}));

import { SearchProviderRegistry } from "../SearchProviderRegistry";
import { UnifiedSearchService } from "../UnifiedSearchService";
import type { SearchProvider, SearchResult } from "../types";

function createMockResult(source: string, id: string, score: number): SearchResult {
    return {
        source,
        id,
        projectId: "test-project",
        relevanceScore: score,
        title: `${source} result ${id}`,
        summary: `Summary for ${id}`,
        retrievalTool: source === "reports" ? "report_read" : source === "conversations" ? "conversation_get" : "lesson_get",
        retrievalArg: id,
    };
}

function createMockProvider(name: string, results: SearchResult[]): SearchProvider {
    return {
        name,
        description: `Mock provider: ${name}`,
        search: async () => results,
    };
}

function createFailingProvider(name: string): SearchProvider {
    return {
        name,
        description: `Failing provider: ${name}`,
        search: async () => {
            throw new Error(`Provider ${name} failed`);
        },
    };
}

describe("UnifiedSearchService", () => {
    beforeEach(() => {
        SearchProviderRegistry.resetInstance();
        UnifiedSearchService.resetInstance();
        mockSearchModelName = undefined;
        mockCreateLLMServiceResult = undefined;
        mockListCollections = async () => [];
        mockQueryWithFilter = async () => [];
    });

    afterEach(() => {
        SearchProviderRegistry.resetInstance();
        UnifiedSearchService.resetInstance();
    });

    it("returns empty results when no providers are registered", async () => {
        const service = UnifiedSearchService.getInstance();
        const result = await service.search({
            query: "test",
            projectId: "test-project",
        });

        expect(result.success).toBe(true);
        expect(result.results).toHaveLength(0);
        expect(result.totalResults).toBe(0);
        expect(result.warnings).toBeDefined();
    });

    it("queries all providers and merges results by relevance", async () => {
        const registry = SearchProviderRegistry.getInstance();
        registry.register(
            createMockProvider("reports", [
                createMockResult("reports", "report-1", 0.9),
                createMockResult("reports", "report-2", 0.7),
            ])
        );
        registry.register(
            createMockProvider("conversations", [
                createMockResult("conversations", "conv-1", 0.85),
                createMockResult("conversations", "conv-2", 0.6),
            ])
        );

        const service = UnifiedSearchService.getInstance();
        const result = await service.search({
            query: "test query",
            projectId: "test-project",
        });

        expect(result.success).toBe(true);
        expect(result.totalResults).toBe(4);
        expect(result.collectionsSearched).toEqual(["reports", "conversations"]);

        // Results should be sorted by relevance (highest first)
        expect(result.results[0].relevanceScore).toBe(0.9);
        expect(result.results[0].id).toBe("report-1");
        expect(result.results[1].relevanceScore).toBe(0.85);
        expect(result.results[1].id).toBe("conv-1");
        expect(result.results[2].relevanceScore).toBe(0.7);
        expect(result.results[3].relevanceScore).toBe(0.6);
    });

    it("respects limit parameter", async () => {
        const registry = SearchProviderRegistry.getInstance();
        registry.register(
            createMockProvider("reports", [
                createMockResult("reports", "r1", 0.9),
                createMockResult("reports", "r2", 0.8),
                createMockResult("reports", "r3", 0.7),
            ])
        );

        const service = UnifiedSearchService.getInstance();
        const result = await service.search({
            query: "test",
            projectId: "test-project",
            limit: 2,
        });

        expect(result.totalResults).toBe(2);
        expect(result.results).toHaveLength(2);
    });

    it("gracefully degrades when a provider fails", async () => {
        const registry = SearchProviderRegistry.getInstance();
        registry.register(
            createMockProvider("reports", [createMockResult("reports", "r1", 0.9)])
        );
        registry.register(createFailingProvider("conversations"));

        const service = UnifiedSearchService.getInstance();
        const result = await service.search({
            query: "test",
            projectId: "test-project",
        });

        expect(result.success).toBe(true);
        expect(result.totalResults).toBe(1);
        expect(result.collectionsSearched).toEqual(["reports"]);
        expect(result.collectionsErrored).toEqual(["conversations"]);
        expect(result.warnings).toBeDefined();
        expect(result.warnings![0]).toContain("conversations");
    });

    it("filters by specified collections", async () => {
        const registry = SearchProviderRegistry.getInstance();
        registry.register(
            createMockProvider("reports", [createMockResult("reports", "r1", 0.9)])
        );
        registry.register(
            createMockProvider("conversations", [createMockResult("conversations", "c1", 0.8)])
        );
        registry.register(
            createMockProvider("lessons", [createMockResult("lessons", "l1", 0.7)])
        );

        const service = UnifiedSearchService.getInstance();
        const result = await service.search({
            query: "test",
            projectId: "test-project",
            collections: ["reports", "lessons"],
        });

        expect(result.collectionsSearched).toEqual(["reports", "lessons"]);
        expect(result.totalResults).toBe(2);
        // Should NOT include conversations
        expect(result.results.every((r) => r.source !== "conversations")).toBe(true);
    });

    it("performs LLM extraction when prompt is provided and model is configured", async () => {
        const registry = SearchProviderRegistry.getInstance();
        registry.register(
            createMockProvider("reports", [createMockResult("reports", "r1", 0.9)])
        );

        mockSearchModelName = "test-search-model";
        mockCreateLLMServiceResult = {
            generateText: async () => ({
                text: "Extracted information about the query",
                usage: {},
            }),
        };

        const service = UnifiedSearchService.getInstance();
        const result = await service.search({
            query: "test",
            projectId: "test-project",
            prompt: "What decisions were made?",
        });

        expect(result.success).toBe(true);
        expect(result.extraction).toBe("Extracted information about the query");
    });

    it("returns results without extraction when LLM is not configured", async () => {
        const registry = SearchProviderRegistry.getInstance();
        registry.register(
            createMockProvider("reports", [createMockResult("reports", "r1", 0.9)])
        );

        // No LLM config
        mockSearchModelName = undefined;
        mockCreateLLMServiceResult = undefined;

        const service = UnifiedSearchService.getInstance();
        const result = await service.search({
            query: "test",
            projectId: "test-project",
            prompt: "What decisions were made?",
        });

        expect(result.success).toBe(true);
        expect(result.totalResults).toBe(1);
        // Extraction should be undefined since no LLM is available
        expect(result.extraction).toBeUndefined();
    });

    it("handles LLM extraction failure gracefully", async () => {
        const registry = SearchProviderRegistry.getInstance();
        registry.register(
            createMockProvider("reports", [createMockResult("reports", "r1", 0.9)])
        );

        mockSearchModelName = "test-model";
        mockCreateLLMServiceResult = {
            generateText: async () => {
                throw new Error("LLM failed");
            },
        };

        const service = UnifiedSearchService.getInstance();
        const result = await service.search({
            query: "test",
            projectId: "test-project",
            prompt: "Extract info",
        });

        // Should succeed with results but no extraction
        expect(result.success).toBe(true);
        expect(result.totalResults).toBe(1);
        expect(result.extraction).toBeUndefined();
    });

    it("handles all providers failing", async () => {
        const registry = SearchProviderRegistry.getInstance();
        registry.register(createFailingProvider("reports"));
        registry.register(createFailingProvider("conversations"));

        const service = UnifiedSearchService.getInstance();
        const result = await service.search({
            query: "test",
            projectId: "test-project",
        });

        expect(result.success).toBe(true);
        expect(result.totalResults).toBe(0);
        expect(result.collectionsErrored).toHaveLength(2);
        expect(result.warnings).toHaveLength(2);
    });

    describe("dynamic collection discovery", () => {
        it("discovers and queries generic RAG collections alongside specialized providers", async () => {
            // Register a specialized provider
            const registry = SearchProviderRegistry.getInstance();
            registry.register(
                createMockProvider("reports", [createMockResult("reports", "r1", 0.9)])
            );

            // RAG returns specialized + extra collections
            mockListCollections = async () => [
                "project_reports",          // covered by specialized "reports" provider
                "conversation_embeddings",  // covered by specialized "conversations" provider
                "lessons",                  // covered by specialized "lessons" provider
                "custom_knowledge",         // NOT covered — should get a generic provider
            ];

            mockQueryWithFilter = async (name: string) => {
                if (name === "custom_knowledge") {
                    return [
                        {
                            document: {
                                id: "doc-1",
                                content: "Custom knowledge content here",
                                metadata: { projectId: "test-project", title: "Custom Doc" },
                            },
                            score: 0.75,
                        },
                    ];
                }
                return [];
            };

            const service = UnifiedSearchService.getInstance();
            const result = await service.search({
                query: "test",
                projectId: "test-project",
            });

            expect(result.success).toBe(true);
            // Should include both specialized (reports) and generic (custom_knowledge)
            expect(result.collectionsSearched).toContain("reports");
            expect(result.collectionsSearched).toContain("custom_knowledge");
            expect(result.totalResults).toBe(2);

            // Verify generic result is included and properly formatted
            const customResult = result.results.find((r) => r.source === "custom_knowledge");
            expect(customResult).toBeDefined();
            expect(customResult!.id).toBe("doc-1");
            expect(customResult!.retrievalTool).toBe("search");
        });

        it("does not create generic providers for specialized collection names", async () => {
            const registry = SearchProviderRegistry.getInstance();
            registry.register(
                createMockProvider("reports", [createMockResult("reports", "r1", 0.9)])
            );

            // Only return collections covered by specialized providers
            mockListCollections = async () => [
                "project_reports",
                "conversation_embeddings",
                "lessons",
            ];

            const service = UnifiedSearchService.getInstance();
            const result = await service.search({
                query: "test",
                projectId: "test-project",
            });

            // Only the registered specialized provider should be queried
            expect(result.collectionsSearched).toEqual(["reports"]);
            expect(result.totalResults).toBe(1);
        });

        it("filters dynamic collections via the collections parameter", async () => {
            const registry = SearchProviderRegistry.getInstance();
            registry.register(
                createMockProvider("reports", [createMockResult("reports", "r1", 0.9)])
            );

            mockListCollections = async () => ["project_reports", "custom_a", "custom_b"];

            mockQueryWithFilter = async (name: string) => [
                {
                    document: {
                        id: `${name}-doc`,
                        content: `Content from ${name}`,
                        metadata: { projectId: "test-project", title: `Doc from ${name}` },
                    },
                    score: 0.8,
                },
            ];

            const service = UnifiedSearchService.getInstance();
            const result = await service.search({
                query: "test",
                projectId: "test-project",
                collections: ["custom_a"],
            });

            // Should only search custom_a, not reports or custom_b
            expect(result.collectionsSearched).toEqual(["custom_a"]);
            expect(result.totalResults).toBe(1);
            expect(result.results[0].source).toBe("custom_a");
        });

        it("degrades gracefully when RAG collection discovery fails", async () => {
            const registry = SearchProviderRegistry.getInstance();
            registry.register(
                createMockProvider("reports", [createMockResult("reports", "r1", 0.9)])
            );

            // RAGService.listCollections() throws
            mockListCollections = async () => {
                throw new Error("RAG unavailable");
            };

            const service = UnifiedSearchService.getInstance();
            const result = await service.search({
                query: "test",
                projectId: "test-project",
            });

            // Should still work with just the specialized providers
            expect(result.success).toBe(true);
            expect(result.collectionsSearched).toEqual(["reports"]);
            expect(result.totalResults).toBe(1);
        });

        it("gracefully handles a failing generic provider among healthy ones", async () => {
            const registry = SearchProviderRegistry.getInstance();
            registry.register(
                createMockProvider("reports", [createMockResult("reports", "r1", 0.9)])
            );

            mockListCollections = async () => ["project_reports", "good_collection", "bad_collection"];

            mockQueryWithFilter = async (name: string) => {
                if (name === "bad_collection") {
                    throw new Error("Collection corrupted");
                }
                return [
                    {
                        document: {
                            id: `${name}-doc`,
                            content: `Content from ${name}`,
                            metadata: { projectId: "test-project", title: `Doc from ${name}` },
                        },
                        score: 0.7,
                    },
                ];
            };

            const service = UnifiedSearchService.getInstance();
            const result = await service.search({
                query: "test",
                projectId: "test-project",
            });

            expect(result.success).toBe(true);
            expect(result.collectionsSearched).toContain("reports");
            expect(result.collectionsSearched).toContain("good_collection");
            expect(result.collectionsErrored).toContain("bad_collection");
            // reports (1) + good_collection (1) = 2
            expect(result.totalResults).toBe(2);
        });
    });
});
