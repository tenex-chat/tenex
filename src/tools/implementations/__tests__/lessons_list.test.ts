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

// Mock ProjectContext
const projectContextMocks = {
    getAllLessons: mock(),
    getLessonsForAgent: mock(),
    getAgentByPubkey: mock(),
};

mock.module("@/services/projects", () => ({
    getProjectContext: () => projectContextMocks,
}));

import { createLessonsListTool } from "../lessons_list";

describe("Lessons List Tool", () => {
    // Valid 64-character hex pubkeys for testing
    const MOCK_PUBKEY_1 = "0".repeat(64);
    const MOCK_PUBKEY_2 = "1".repeat(64);
    const MOCK_PUBKEY_UNKNOWN = "f".repeat(64);

    const createMockContext = (
        overrides: Partial<ToolExecutionContext> = {}
    ): ToolExecutionContext => {
        return {
            agent: {
                name: "test-agent",
                slug: "test-agent",
                pubkey: MOCK_PUBKEY_1,
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
            ...overrides,
        } as ToolExecutionContext;
    };

    const createMockLesson = (id: string, title: string, pubkey: string) => ({
        id,
        title,
        lesson: `This is lesson ${title}`,
        content: `This is lesson ${title}`,
        detailed: undefined,
        category: "testing",
        hashtags: ["test"],
        pubkey,
        created_at: Date.now() / 1000,
    });

    beforeEach(() => {
        // Reset all mocks
        projectContextMocks.getAllLessons.mockReset();
        projectContextMocks.getLessonsForAgent.mockReset();
        projectContextMocks.getAgentByPubkey.mockReset();
    });

    describe("listing all lessons", () => {
        it("should return all lessons from all agents", async () => {
            const mockLessons = [
                createMockLesson("lesson-1", "Lesson One", "MOCK_PUBKEY_1"),
                createMockLesson("lesson-2", "Lesson Two", "MOCK_PUBKEY_2"),
            ];

            projectContextMocks.getAllLessons.mockReturnValue(mockLessons);
            projectContextMocks.getAgentByPubkey.mockImplementation((pubkey: string) => {
                if (pubkey === "MOCK_PUBKEY_1") {
                    return { name: "agent-one", slug: "agent-one" };
                }
                if (pubkey === "MOCK_PUBKEY_2") {
                    return { name: "agent-two", slug: "agent-two" };
                }
                return null;
            });

            const context = createMockContext();
            const tool = createLessonsListTool(context);

            const result = await tool.execute({});

            expect(result).toMatchObject({
                success: true,
                totalCount: 2,
            });
            expect(result.lessons).toHaveLength(2);
            expect(result.lessons[0]).toMatchObject({
                eventId: "lesson-1",
                title: "Lesson One",
                author: "agent-one",
                category: "testing",
                hasDetailed: false,
            });
            expect(projectContextMocks.getAllLessons).toHaveBeenCalled();
        });

        it("should handle empty lesson list", async () => {
            projectContextMocks.getAllLessons.mockReturnValue([]);

            const context = createMockContext();
            const tool = createLessonsListTool(context);

            const result = await tool.execute({});

            expect(result).toMatchObject({
                success: true,
                totalCount: 0,
                lessons: [],
            });
        });
    });

    describe("filtering by agent", () => {
        it("should return lessons for a specific agent", async () => {
            const mockLessons = [
                createMockLesson("lesson-1", "Lesson One", "MOCK_PUBKEY_1"),
            ];

            projectContextMocks.getLessonsForAgent.mockReturnValue(mockLessons);
            projectContextMocks.getAgentByPubkey.mockReturnValue({
                name: "agent-one",
                slug: "agent-one",
            });

            const context = createMockContext();
            const tool = createLessonsListTool(context);

            const result = await tool.execute({ agentPubkey: MOCK_PUBKEY_1 });

            expect(result).toMatchObject({
                success: true,
                totalCount: 1,
                agentFilter: MOCK_PUBKEY_1,
            });
            expect(result.lessons).toHaveLength(1);
            expect(projectContextMocks.getLessonsForAgent).toHaveBeenCalledWith(
                MOCK_PUBKEY_1
            );
        });
    });

    describe("lesson details", () => {
        it("should include detailed flag when lesson has detailed content", async () => {
            const mockLesson = {
                ...createMockLesson("lesson-1", "Lesson One", "MOCK_PUBKEY_1"),
                detailed: "This is a detailed explanation",
            };

            projectContextMocks.getAllLessons.mockReturnValue([mockLesson]);
            projectContextMocks.getAgentByPubkey.mockReturnValue({
                name: "agent-one",
                slug: "agent-one",
            });

            const context = createMockContext();
            const tool = createLessonsListTool(context);

            const result = await tool.execute({});

            expect(result.lessons[0]).toMatchObject({
                hasDetailed: true,
            });
        });

        it("should fall back to pubkey when agent not found", async () => {
            const mockLesson = createMockLesson(
                "lesson-1",
                "Lesson One",
                "MOCK_PUBKEY_UNKNOWN"
            );

            projectContextMocks.getAllLessons.mockReturnValue([mockLesson]);
            projectContextMocks.getAgentByPubkey.mockReturnValue(null);

            const context = createMockContext();
            const tool = createLessonsListTool(context);

            const result = await tool.execute({});

            expect(result.lessons[0]).toMatchObject({
                author: "MOCK_PUBKEY_UNKNOWN",
            });
        });

        it("should handle lessons without title", async () => {
            const mockLesson = {
                ...createMockLesson("lesson-1", "", "MOCK_PUBKEY_1"),
                title: undefined as any,
            };

            projectContextMocks.getAllLessons.mockReturnValue([mockLesson]);
            projectContextMocks.getAgentByPubkey.mockReturnValue({
                name: "agent-one",
                slug: "agent-one",
            });

            const context = createMockContext();
            const tool = createLessonsListTool(context);

            const result = await tool.execute({});

            expect(result.lessons[0].title).toBe("Untitled");
        });
    });

    describe("sorting", () => {
        it("should sort lessons by creation date, most recent first", async () => {
            const now = Date.now() / 1000;
            const mockLessons = [
                { ...createMockLesson("lesson-1", "Old", "MOCK_PUBKEY_1"), created_at: now - 100 },
                { ...createMockLesson("lesson-2", "New", "MOCK_PUBKEY_1"), created_at: now },
                { ...createMockLesson("lesson-3", "Middle", "MOCK_PUBKEY_1"), created_at: now - 50 },
            ];

            projectContextMocks.getAllLessons.mockReturnValue(mockLessons);
            projectContextMocks.getAgentByPubkey.mockReturnValue({
                name: "agent-one",
                slug: "agent-one",
            });

            const context = createMockContext();
            const tool = createLessonsListTool(context);

            const result = await tool.execute({});

            expect(result.lessons[0].title).toBe("New");
            expect(result.lessons[1].title).toBe("Middle");
            expect(result.lessons[2].title).toBe("Old");
        });
    });

    describe("input validation", () => {
        it("should reject empty string agentPubkey", async () => {
            const context = createMockContext();
            const tool = createLessonsListTool(context);

            const result = await tool.execute({ agentPubkey: "" });

            expect(result).toMatchObject({
                type: "error-text",
                text: "Agent pubkey cannot be empty",
            });
        });

        it("should reject whitespace-only agentPubkey", async () => {
            const context = createMockContext();
            const tool = createLessonsListTool(context);

            const result = await tool.execute({ agentPubkey: "   " });

            expect(result).toMatchObject({
                type: "error-text",
                text: "Agent pubkey cannot be empty",
            });
        });

        it("should reject invalid hex format - too short", async () => {
            const context = createMockContext();
            const tool = createLessonsListTool(context);

            const result = await tool.execute({ agentPubkey: "abc123" });

            expect(result).toMatchObject({
                type: "error-text",
            });
            expect(result.text).toContain("Invalid agent pubkey format");
            expect(result.text).toContain("64-character hex string");
        });

        it("should reject invalid hex format - wrong characters", async () => {
            const context = createMockContext();
            const tool = createLessonsListTool(context);

            const invalidPubkey = "z".repeat(64); // Invalid hex character 'z'
            const result = await tool.execute({ agentPubkey: invalidPubkey });

            expect(result).toMatchObject({
                type: "error-text",
            });
            expect(result.text).toContain("Invalid agent pubkey format");
        });

        it("should reject invalid hex format - mixed with special characters", async () => {
            const context = createMockContext();
            const tool = createLessonsListTool(context);

            const result = await tool.execute({
                agentPubkey: "abc123-def456-" + "0".repeat(50),
            });

            expect(result).toMatchObject({
                type: "error-text",
            });
            expect(result.text).toContain("Invalid agent pubkey format");
        });

        it("should accept valid 64-char hex pubkey (lowercase)", async () => {
            const validPubkey = "a".repeat(64);
            const mockLessons = [createMockLesson("lesson-1", "Test", validPubkey)];

            projectContextMocks.getLessonsForAgent.mockReturnValue(mockLessons);
            projectContextMocks.getAgentByPubkey.mockReturnValue({
                name: "test-agent",
                slug: "test-agent",
            });

            const context = createMockContext();
            const tool = createLessonsListTool(context);

            const result = await tool.execute({ agentPubkey: validPubkey });

            expect(result).toMatchObject({
                success: true,
                totalCount: 1,
            });
        });

        it("should accept valid 64-char hex pubkey (uppercase)", async () => {
            const validPubkey = "A".repeat(64);
            const mockLessons = [createMockLesson("lesson-1", "Test", validPubkey)];

            projectContextMocks.getLessonsForAgent.mockReturnValue(mockLessons);
            projectContextMocks.getAgentByPubkey.mockReturnValue({
                name: "test-agent",
                slug: "test-agent",
            });

            const context = createMockContext();
            const tool = createLessonsListTool(context);

            const result = await tool.execute({ agentPubkey: validPubkey });

            expect(result).toMatchObject({
                success: true,
                totalCount: 1,
            });
        });

        it("should accept valid 64-char hex pubkey (mixed case)", async () => {
            const validPubkey = "a1B2c3D4".repeat(8); // 64 chars mixed case
            const mockLessons = [createMockLesson("lesson-1", "Test", validPubkey)];

            projectContextMocks.getLessonsForAgent.mockReturnValue(mockLessons);
            projectContextMocks.getAgentByPubkey.mockReturnValue({
                name: "test-agent",
                slug: "test-agent",
            });

            const context = createMockContext();
            const tool = createLessonsListTool(context);

            const result = await tool.execute({ agentPubkey: validPubkey });

            expect(result).toMatchObject({
                success: true,
                totalCount: 1,
            });
        });
    });
});
