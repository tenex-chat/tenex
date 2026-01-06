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

// Use object to hold mock functions so we can swap them
const ragMocks = {
    createCollection: mock().mockResolvedValue(undefined),
    addDocuments: mock().mockResolvedValue(undefined),
};

mock.module("@/services/rag/RAGService", () => ({
    RAGService: {
        getInstance: () => ({
            createCollection: (...args: any[]) => ragMocks.createCollection(...args),
            addDocuments: (...args: any[]) => ragMocks.addDocuments(...args),
        }),
    },
}));

import { createLessonLearnTool } from "../learn";

describe("Learn Tool", () => {
    let mockLessonEvent: { encode: () => string };
    let mockAgentPublisher: { lesson: ReturnType<typeof mock> };

    const createMockContext = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => {
        mockLessonEvent = {
            encode: () => "mock-encoded-event",
        };

        mockAgentPublisher = {
            lesson: mock().mockResolvedValue(mockLessonEvent),
        };

        return {
            agent: {
                name: "dev-senior",
                slug: "dev-senior",
                pubkey: "mock-agent-pubkey",
                eventId: "mock-agent-event-id",
                llmConfig: { model: "gpt-4" },
            } as any,
            conversationId: "mock-conversation-id",
            conversationCoordinator: {} as any,
            triggeringEvent: {
                id: "mock-triggering-event-id",
                tags: [],
            } as any,
            agentPublisher: mockAgentPublisher as any,
            phase: "reflection",
            ralNumber: 1,
            projectBasePath: "/tmp/test",
            workingDirectory: "/tmp/test",
            currentBranch: "main",
            getConversation: () => ({
                getRootEventId: () => "mock-root-event-id",
            }) as any,
            ...overrides,
        } as ToolExecutionContext;
    };

    beforeEach(() => {
        ragMocks.createCollection.mockReset().mockResolvedValue(undefined);
        ragMocks.addDocuments.mockReset().mockResolvedValue(undefined);
    });

    describe("Execution", () => {
        it("should successfully create and publish lesson", async () => {
            const context = createMockContext();
            const tool = createLessonLearnTool(context);

            const result = await tool.execute({
                title: "Performance Optimization",
                lesson: "Use React.memo for expensive component renders",
            });

            expect(result.message).toContain("Lesson recorded");
            expect(result.title).toBe("Performance Optimization");
            expect(result.eventId).toBe("mock-encoded-event");
            expect(mockAgentPublisher.lesson).toHaveBeenCalled();
        });

        it("should handle detailed lesson version", async () => {
            const context = createMockContext();
            const tool = createLessonLearnTool(context);

            const result = await tool.execute({
                title: "Error Handling",
                lesson: "Always handle async errors",
                detailed: "When working with async/await, always wrap in try-catch blocks to handle potential errors gracefully.",
            });

            expect(result.message).toContain("with detailed version");
            expect(result.hasDetailed).toBe(true);
        });

        it("should handle category and hashtags", async () => {
            const context = createMockContext();
            const tool = createLessonLearnTool(context);

            const result = await tool.execute({
                title: "Architecture Decision",
                lesson: "Use event sourcing for audit trails",
                category: "architecture",
                hashtags: ["event-sourcing", "audit"],
            });

            expect(result.message).toContain("Lesson recorded");
            expect(result.title).toBe("Architecture Decision");
        });

        // NOTE: Tests for missing agentPublisher/ralNumber removed - now enforced by ToolExecutionContext type

        it("should add lesson to RAG collection", async () => {
            const context = createMockContext();
            const tool = createLessonLearnTool(context);

            await tool.execute({
                title: "RAG Test",
                lesson: "Test lesson for RAG",
                category: "testing",
                hashtags: ["rag", "test"],
            });

            expect(ragMocks.createCollection).toHaveBeenCalledWith("lessons");
            expect(ragMocks.addDocuments).toHaveBeenCalledWith(
                "lessons",
                expect.arrayContaining([
                    expect.objectContaining({
                        id: "mock-encoded-event",
                        content: "Test lesson for RAG",
                        metadata: expect.objectContaining({
                            title: "RAG Test",
                            category: "testing",
                            hashtags: ["rag", "test"],
                            type: "lesson",
                        }),
                    }),
                ])
            );
        });

        it("should continue even if RAG integration fails", async () => {
            ragMocks.addDocuments.mockReset().mockRejectedValue(new Error("RAG error"));

            const context = createMockContext();
            const tool = createLessonLearnTool(context);

            // Should not throw, just warn
            const result = await tool.execute({
                title: "Test",
                lesson: "Test lesson",
            });

            expect(result.message).toContain("Lesson recorded");
        });
    });

    describe("Event Context", () => {
        it("should pass correct event context to agentPublisher", async () => {
            const context = createMockContext();
            const tool = createLessonLearnTool(context);

            await tool.execute({
                title: "Context Test",
                lesson: "Testing event context",
            });

            expect(mockAgentPublisher.lesson).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: "Context Test",
                    lesson: "Testing event context",
                }),
                expect.objectContaining({
                    conversationId: "mock-conversation-id",
                    ralNumber: 1,
                })
            );
        });
    });
});
