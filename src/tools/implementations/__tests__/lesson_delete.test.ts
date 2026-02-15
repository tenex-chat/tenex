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

// Mock NDK and NDKEvent for deletion event creation
const ndkEventMocks = {
    publish: mock().mockResolvedValue(new Set()),
};

// Create a mock NDKEvent class that tracks instances
let lastCreatedEvent: any = null;
mock.module("@nostr-dev-kit/ndk", () => ({
    NDKEvent: class MockNDKEvent {
        ndk: any;
        kind: number | undefined;
        tags: string[][] = [];
        content: string = "";

        constructor(ndk: any) {
            this.ndk = ndk;
            lastCreatedEvent = this;
        }

        publish() {
            return ndkEventMocks.publish();
        }
    },
}));

mock.module("@/nostr/ndkClient", () => ({
    getNDK: () => ({ /* mock NDK instance */ }),
}));

// Use object to hold mock functions so we can swap them
const ragMocks = {
    deleteDocumentById: mock().mockResolvedValue(undefined),
};

mock.module("@/services/rag/RAGService", () => ({
    RAGService: {
        getInstance: () => ({
            deleteDocumentById: (...args: any[]) => ragMocks.deleteDocumentById(...args),
        }),
    },
}));

// Mock ProjectContext
const projectContextMocks = {
    getAllLessons: mock(),
    getLessonsForAgent: mock(),
    removeLesson: mock(),
};

mock.module("@/services/projects", () => ({
    getProjectContext: () => projectContextMocks,
}));

// Mock the normalization utility
mock.module("@/utils/nostr-entity-parser", () => ({
    normalizeLessonEventId: (input: string, _lessons: any[]) => {
        // Simple mock: if starts with "invalid", return error
        if (input.startsWith("invalid")) {
            return { success: false, error: `Invalid event ID format: ${input}` };
        }
        // Otherwise return the input as-is (assuming it's already normalized)
        return { success: true, eventId: input };
    },
}));

import { createLessonDeleteTool } from "../lesson_delete";

describe("Lesson Delete Tool", () => {
    let mockLesson: {
        id: string;
        title: string;
        pubkey: string;
        encode: () => string;
    };

    // Track agent.sign calls
    const agentSignMock = mock().mockResolvedValue(undefined);

    const createMockContext = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => {
        return {
            agent: {
                name: "test-agent",
                slug: "test-agent",
                pubkey: "agent-pubkey-123",
                eventId: "mock-agent-event-id",
                llmConfig: { model: "gpt-4" },
                sign: agentSignMock,
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
            ...overrides,
        } as ToolExecutionContext;
    };

    beforeEach(() => {
        // Reset all mocks
        ragMocks.deleteDocumentById.mockReset().mockResolvedValue(undefined);
        projectContextMocks.getAllLessons.mockReset();
        projectContextMocks.getLessonsForAgent.mockReset();
        projectContextMocks.removeLesson.mockReset();
        agentSignMock.mockReset().mockResolvedValue(undefined);
        ndkEventMocks.publish.mockReset().mockResolvedValue(new Set());
        lastCreatedEvent = null;

        // Create fresh mock lesson
        mockLesson = {
            id: "lesson-event-id-123",
            title: "Test Lesson",
            pubkey: "agent-pubkey-123",
            encode: () => "encoded-lesson-id",
        };
    });

    describe("Successful Deletion", () => {
        it("should successfully delete a lesson owned by the agent", async () => {
            projectContextMocks.getAllLessons.mockReturnValue([mockLesson]);
            projectContextMocks.getLessonsForAgent.mockReturnValue([mockLesson]);
            projectContextMocks.removeLesson.mockReturnValue(true);

            const context = createMockContext();
            const tool = createLessonDeleteTool(context);

            const result = await tool.execute({
                eventId: "lesson-event-id-123",
            });

            expect(result).toEqual({
                success: true,
                eventId: "lesson-event-id-123",
                title: "Test Lesson",
                message: 'Lesson "Test Lesson" has been deleted.',
            });
            // Verify NIP-09 deletion event was created correctly
            expect(lastCreatedEvent).not.toBeNull();
            expect(lastCreatedEvent.kind).toBe(5);
            expect(lastCreatedEvent.tags).toEqual([["e", "lesson-event-id-123"]]);
            expect(lastCreatedEvent.content).toBe("");
            // Verify agent.sign was called
            expect(agentSignMock).toHaveBeenCalledWith(lastCreatedEvent);
            // Verify event was published
            expect(ndkEventMocks.publish).toHaveBeenCalled();
            expect(projectContextMocks.removeLesson).toHaveBeenCalledWith(
                "agent-pubkey-123",
                "lesson-event-id-123"
            );
        });

        it("should include reason in the message when provided", async () => {
            projectContextMocks.getAllLessons.mockReturnValue([mockLesson]);
            projectContextMocks.getLessonsForAgent.mockReturnValue([mockLesson]);
            projectContextMocks.removeLesson.mockReturnValue(true);

            const context = createMockContext();
            const tool = createLessonDeleteTool(context);

            const result = await tool.execute({
                eventId: "lesson-event-id-123",
                reason: "Outdated information",
            });

            expect(result).toEqual({
                success: true,
                eventId: "lesson-event-id-123",
                title: "Test Lesson",
                message: 'Lesson "Test Lesson" has been deleted (reason: Outdated information).',
            });
            // Verify reason is stored in event content (NIP-09)
            expect(lastCreatedEvent.content).toBe("Outdated information");
            expect(agentSignMock).toHaveBeenCalled();
            expect(ndkEventMocks.publish).toHaveBeenCalled();
        });

        it("should handle lessons without a title", async () => {
            mockLesson.title = "";
            projectContextMocks.getAllLessons.mockReturnValue([mockLesson]);
            projectContextMocks.getLessonsForAgent.mockReturnValue([mockLesson]);
            projectContextMocks.removeLesson.mockReturnValue(true);

            const context = createMockContext();
            const tool = createLessonDeleteTool(context);

            const result = await tool.execute({
                eventId: "lesson-event-id-123",
            });

            expect(result).toEqual({
                success: true,
                eventId: "lesson-event-id-123",
                title: "Untitled",
                message: 'Lesson "Untitled" has been deleted.',
            });
        });
    });

    describe("Permission Errors", () => {
        it("should return expected error when trying to delete another agent's lesson", async () => {
            const otherAgentLesson = {
                ...mockLesson,
                pubkey: "other-agent-pubkey",
            };
            projectContextMocks.getAllLessons.mockReturnValue([otherAgentLesson]);
            projectContextMocks.getLessonsForAgent.mockReturnValue([]);

            const context = createMockContext();
            const tool = createLessonDeleteTool(context);

            const result = await tool.execute({
                eventId: "lesson-event-id-123",
            });

            expect(result).toEqual({
                type: "error-text",
                text: 'Cannot delete lesson "lesson-event-id-123": You can only delete your own lessons.',
            });
            // Verify no deletion event was signed or published
            expect(agentSignMock).not.toHaveBeenCalled();
            expect(ndkEventMocks.publish).not.toHaveBeenCalled();
        });

        it("should return expected error when lesson is not found", async () => {
            projectContextMocks.getAllLessons.mockReturnValue([]);
            projectContextMocks.getLessonsForAgent.mockReturnValue([]);

            const context = createMockContext();
            const tool = createLessonDeleteTool(context);

            const result = await tool.execute({
                eventId: "nonexistent-lesson-id",
            });

            expect(result).toEqual({
                type: "error-text",
                text: 'No lesson found with event ID: "nonexistent-lesson-id"',
            });
        });

        it("should return expected error for invalid event ID format", async () => {
            projectContextMocks.getAllLessons.mockReturnValue([]);

            const context = createMockContext();
            const tool = createLessonDeleteTool(context);

            const result = await tool.execute({
                eventId: "invalid-format-xyz",
            });

            expect(result).toEqual({
                type: "error-text",
                text: "Invalid event ID format: invalid-format-xyz",
            });
        });
    });

    describe("Error Handling Contract", () => {
        it("should throw when agent.sign() fails unexpectedly", async () => {
            const signError = new Error("Signing failed");
            agentSignMock.mockRejectedValue(signError);
            projectContextMocks.getAllLessons.mockReturnValue([mockLesson]);
            projectContextMocks.getLessonsForAgent.mockReturnValue([mockLesson]);

            const context = createMockContext();
            const tool = createLessonDeleteTool(context);

            // Per error handling contract: unexpected failures should throw
            await expect(
                tool.execute({ eventId: "lesson-event-id-123" })
            ).rejects.toThrow("Signing failed");

            // removeLesson should NOT be called since signing failed
            expect(projectContextMocks.removeLesson).not.toHaveBeenCalled();
        });

        it("should throw when publish() fails unexpectedly", async () => {
            const publishError = new Error("Network failure during deletion");
            ndkEventMocks.publish.mockRejectedValue(publishError);
            projectContextMocks.getAllLessons.mockReturnValue([mockLesson]);
            projectContextMocks.getLessonsForAgent.mockReturnValue([mockLesson]);

            const context = createMockContext();
            const tool = createLessonDeleteTool(context);

            // Per error handling contract: unexpected failures should throw
            await expect(
                tool.execute({ eventId: "lesson-event-id-123" })
            ).rejects.toThrow("Network failure during deletion");

            // removeLesson should NOT be called since publish failed
            expect(projectContextMocks.removeLesson).not.toHaveBeenCalled();
        });
    });

    describe("RAG Cleanup", () => {
        it("should remove lesson from RAG collection", async () => {
            projectContextMocks.getAllLessons.mockReturnValue([mockLesson]);
            projectContextMocks.getLessonsForAgent.mockReturnValue([mockLesson]);
            projectContextMocks.removeLesson.mockReturnValue(true);

            const context = createMockContext();
            const tool = createLessonDeleteTool(context);

            await tool.execute({ eventId: "lesson-event-id-123" });

            expect(ragMocks.deleteDocumentById).toHaveBeenCalledWith(
                "lessons",
                "encoded-lesson-id"
            );
        });

        it("should continue even if RAG cleanup fails", async () => {
            ragMocks.deleteDocumentById.mockRejectedValue(new Error("RAG cleanup failed"));
            projectContextMocks.getAllLessons.mockReturnValue([mockLesson]);
            projectContextMocks.getLessonsForAgent.mockReturnValue([mockLesson]);
            projectContextMocks.removeLesson.mockReturnValue(true);

            const context = createMockContext();
            const tool = createLessonDeleteTool(context);

            // Should not throw, just warn and continue
            const result = await tool.execute({ eventId: "lesson-event-id-123" });

            expect(result).toEqual({
                success: true,
                eventId: "lesson-event-id-123",
                title: "Test Lesson",
                message: 'Lesson "Test Lesson" has been deleted.',
            });
            // removeLesson should still be called
            expect(projectContextMocks.removeLesson).toHaveBeenCalled();
        });
    });

    describe("Project Context Integration", () => {
        it("should call removeLesson to update cache and trigger recompilation", async () => {
            projectContextMocks.getAllLessons.mockReturnValue([mockLesson]);
            projectContextMocks.getLessonsForAgent.mockReturnValue([mockLesson]);
            projectContextMocks.removeLesson.mockReturnValue(true);

            const context = createMockContext();
            const tool = createLessonDeleteTool(context);

            await tool.execute({ eventId: "lesson-event-id-123" });

            // Verify removeLesson was called with correct arguments
            // This method also triggers prompt recompilation internally
            expect(projectContextMocks.removeLesson).toHaveBeenCalledWith(
                "agent-pubkey-123",
                "lesson-event-id-123"
            );
        });
    });
});
