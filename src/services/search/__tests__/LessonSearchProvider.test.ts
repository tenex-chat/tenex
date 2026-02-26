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

// Track RAG service calls
let mockCollections: string[] = [];
let queryWithFilterCalls: Array<{ collection: string; query: string; topK: number; filter?: string }> = [];
let queryWithFilterResults: any[] = [];

mock.module("@/services/rag/RAGService", () => ({
    RAGService: {
        getInstance: () => ({
            listCollections: async () => mockCollections,
            queryWithFilter: async (collection: string, query: string, topK: number, filter?: string) => {
                queryWithFilterCalls.push({ collection, query, topK, filter });
                return queryWithFilterResults;
            },
        }),
    },
}));

import { LessonSearchProvider } from "../providers/LessonSearchProvider";

describe("LessonSearchProvider", () => {
    let provider: LessonSearchProvider;

    beforeEach(() => {
        provider = new LessonSearchProvider();
        mockCollections = ["lessons"];
        queryWithFilterCalls = [];
        queryWithFilterResults = [];
    });

    afterEach(() => {
        mockCollections = [];
        queryWithFilterCalls = [];
        queryWithFilterResults = [];
    });

    it("has correct name and description", () => {
        expect(provider.name).toBe("lessons");
        expect(provider.description).toBeTruthy();
    });

    it("returns empty results when lessons collection does not exist", async () => {
        mockCollections = [];

        const results = await provider.search("test query", "project-123", 10, 0.3);
        expect(results).toHaveLength(0);
        expect(queryWithFilterCalls).toHaveLength(0);
    });

    it("queries with project filter and transforms results", async () => {
        queryWithFilterResults = [
            {
                document: {
                    id: "nevent1abc123",
                    content: "This is a lesson about debugging",
                    metadata: {
                        title: "Debugging Tips",
                        category: "debugging",
                        hashtags: ["debug", "tips"],
                        agentPubkey: "pubkey123",
                        agentName: "test-agent",
                        timestamp: 1708000000000,
                        projectId: "project-123",
                        type: "lesson",
                    },
                },
                score: 0.85,
            },
        ];

        const results = await provider.search("debugging", "project-123", 10, 0.3);

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
            source: "lessons",
            id: "nevent1abc123",
            projectId: "project-123",
            relevanceScore: 0.85,
            title: "Debugging Tips",
            summary: "This is a lesson about debugging",
            createdAt: 1708000000000,
            author: "pubkey123",
            authorName: "test-agent",
            tags: ["debug", "tips"],
            retrievalTool: "lesson_get",
            retrievalArg: "nevent1abc123",
        });

        // Verify SQL filter was applied
        expect(queryWithFilterCalls).toHaveLength(1);
        expect(queryWithFilterCalls[0].filter).toContain("project-123");
        expect(queryWithFilterCalls[0].collection).toBe("lessons");
    });

    it("filters results below minScore threshold", async () => {
        queryWithFilterResults = [
            {
                document: {
                    id: "lesson1",
                    content: "High relevance",
                    metadata: { title: "Good", projectId: "p1" },
                },
                score: 0.8,
            },
            {
                document: {
                    id: "lesson2",
                    content: "Low relevance",
                    metadata: { title: "Bad", projectId: "p1" },
                },
                score: 0.2,
            },
        ];

        const results = await provider.search("test", "p1", 10, 0.5);

        expect(results).toHaveLength(1);
        expect(results[0].id).toBe("lesson1");
    });

    it("respects limit parameter", async () => {
        queryWithFilterResults = Array.from({ length: 5 }, (_, i) => ({
            document: {
                id: `lesson${i}`,
                content: `Content ${i}`,
                metadata: { title: `Lesson ${i}`, projectId: "p1" },
            },
            score: 0.9 - i * 0.1,
        }));

        const results = await provider.search("test", "p1", 2, 0.3);

        expect(results).toHaveLength(2);
    });

    it("uses fallback projectId when metadata lacks it", async () => {
        queryWithFilterResults = [
            {
                document: {
                    id: "lesson1",
                    content: "No project in metadata",
                    metadata: { title: "Test" },
                },
                score: 0.8,
            },
        ];

        const results = await provider.search("test", "fallback-project", 10, 0.3);

        expect(results[0].projectId).toBe("fallback-project");
    });
});
