import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ToolExecutionContext } from "@/tools/types";

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

// Mock RAGService
const ragServiceMocks = {
    listCollections: mock(),
    getAllCollectionStats: mock(),
};

mock.module("@/services/rag/RAGService", () => ({
    RAGService: {
        getInstance: () => ragServiceMocks,
    },
}));

import { createRAGListCollectionsTool } from "../rag_list_collections";

describe("rag_list_collections tool", () => {
    const MOCK_PUBKEY = "0".repeat(64);

    const createMockContext = (): ToolExecutionContext => {
        return {
            agent: {
                name: "test-agent",
                slug: "test-agent",
                pubkey: MOCK_PUBKEY,
                eventId: "mock-agent-event-id",
                llmConfig: { model: "gpt-4" },
            } as any,
            conversationId: "mock-conversation-id",
            conversationCoordinator: {} as any,
            triggeringEvent: {
                id: "mock-triggering-event-id",
                tags: [],
            } as any,
            agentPublisher: {} as any,
            phase: "execution",
            ralNumber: 1,
            projectBasePath: "/tmp/test",
            workingDirectory: "/tmp/test",
            currentBranch: "main",
            getConversation: () => ({
                getRootEventId: () => "mock-root-event-id",
            }) as any,
        } as ToolExecutionContext;
    };

    /** executeToolWithErrorHandling returns JSON.stringify(result) */
    const parseResult = (result: unknown) => JSON.parse(result as string);

    beforeEach(() => {
        ragServiceMocks.listCollections.mockReset();
        ragServiceMocks.getAllCollectionStats.mockReset();
    });

    describe("include_stats=false (default)", () => {
        it("should return collection names without stats", async () => {
            ragServiceMocks.listCollections.mockResolvedValue(["coll_a", "coll_b"]);

            const context = createMockContext();
            const tool = createRAGListCollectionsTool(context);
            const result = parseResult(await tool.execute({ description: "List available collections" }));

            expect(result).toMatchObject({
                success: true,
                collections_count: 2,
                collections: ["coll_a", "coll_b"],
            });
            expect(ragServiceMocks.listCollections).toHaveBeenCalledTimes(1);
            expect(ragServiceMocks.getAllCollectionStats).not.toHaveBeenCalled();
        });

        it("should handle empty collections list", async () => {
            ragServiceMocks.listCollections.mockResolvedValue([]);

            const context = createMockContext();
            const tool = createRAGListCollectionsTool(context);
            const result = parseResult(await tool.execute({ description: "List available collections" }));

            expect(result).toMatchObject({
                success: true,
                collections_count: 0,
                collections: [],
            });
        });
    });

    describe("include_stats=true", () => {
        it("should return per-collection stats with expected fields", async () => {
            ragServiceMocks.getAllCollectionStats.mockResolvedValue([
                { name: "coll_a", totalDocCount: 100, agentDocCount: 25 },
                { name: "coll_b", totalDocCount: 50, agentDocCount: 0 },
            ]);

            const context = createMockContext();
            const tool = createRAGListCollectionsTool(context);
            const result = parseResult(await tool.execute({ description: "List collections with stats", include_stats: true }));

            expect(result).toMatchObject({
                success: true,
                collections_count: 2,
            });

            // Verify shape of each collection object
            const collections = result.collections as Array<{
                name: string;
                total_documents: number;
                agent_documents: number;
            }>;
            expect(collections).toHaveLength(2);

            expect(collections[0]).toEqual({
                name: "coll_a",
                total_documents: 100,
                agent_documents: 25,
            });
            expect(collections[1]).toEqual({
                name: "coll_b",
                total_documents: 50,
                agent_documents: 0,
            });

            // Should NOT call listCollections separately (getAllCollectionStats handles it)
            expect(ragServiceMocks.listCollections).not.toHaveBeenCalled();
            expect(ragServiceMocks.getAllCollectionStats).toHaveBeenCalledTimes(1);
            expect(ragServiceMocks.getAllCollectionStats).toHaveBeenCalledWith(MOCK_PUBKEY);
        });

        it("should handle empty collections with stats", async () => {
            ragServiceMocks.getAllCollectionStats.mockResolvedValue([]);

            const context = createMockContext();
            const tool = createRAGListCollectionsTool(context);
            const result = parseResult(await tool.execute({ description: "List collections with stats", include_stats: true }));

            expect(result).toMatchObject({
                success: true,
                collections_count: 0,
                collections: [],
            });
        });
    });
});
