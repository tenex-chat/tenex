import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ToolExecutionContext } from "@/tools/types";
import type { AgentInstance } from "@/agents/types";
import { config } from "@/services/ConfigService";

// Mock dependencies - must be before imports
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(),
        warn: mock(),
        error: mock(),
        debug: mock(),
    },
}));

// Mock PubkeyService
mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getNameSync: (pk: string) => pk.slice(0, 8),
    }),
}));

// Mock llmServiceFactory
mock.module("@/llm", () => ({
    llmServiceFactory: {
        createService: mock(),
    },
}));


// Store mock conversation data
let mockConversationData: {
    id: string;
    title?: string;
    metadata?: Record<string, unknown>;
    executionTime?: unknown;
    messages: Array<{
        messageType: "text" | "tool-call" | "tool-result";
        content: string;
        toolData?: unknown;
        pubkey: string;
        eventId: string;
        timestamp: number;
        ral?: unknown;
        targetedPubkeys?: string[];
    }>;
} | null = null;

const mockGetAllMessages = mock(() => mockConversationData?.messages ?? []);
const mockGetMessageCount = mock(() => mockConversationData?.messages.length ?? 0);
const mockGetConversation = mock(() => mockConversationData ? {
    id: mockConversationData.id,
    title: mockConversationData.title,
    metadata: mockConversationData.metadata,
    executionTime: mockConversationData.executionTime,
    getAllMessages: mockGetAllMessages,
    getMessageCount: mockGetMessageCount,
} : null);
import { createConversationGetTool } from "../conversation_get";

describe("conversation_get Tool", () => {
    let mockContext: ToolExecutionContext;
    let mockAgent: AgentInstance;
    let loadConfigSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        loadConfigSpy = spyOn(config, "loadConfig").mockResolvedValue({
            llms: {
                default: null,
                summarization: null,
                configurations: {},
            },
        });

        mockAgent = {
            name: "test-agent",
            pubkey: "mock-agent-pubkey",
        } as AgentInstance;

        mockContext = {
            agent: mockAgent,
            conversationId: "test-conversation-id",
            getConversation: mockGetConversation,
        } as unknown as ToolExecutionContext;

        // Reset conversation data
        mockConversationData = null;
    });

    afterEach(() => {
        loadConfigSpy.mockRestore();
        // Reset mockGetConversation to its original implementation
        mockGetConversation.mockImplementation(() => mockConversationData ? {
            id: mockConversationData.id,
            title: mockConversationData.title,
            metadata: mockConversationData.metadata,
            executionTime: mockConversationData.executionTime,
            getAllMessages: mockGetAllMessages,
            getMessageCount: mockGetMessageCount,
        } : null);
    });

    describe("Output Format", () => {
        it("should return messages as a formatted multi-line string", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                title: "Test Conversation",
                messages: [
                    {
                        messageType: "text",
                        content: "Hello",
                        pubkey: "user-pub1",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Hi there!",
                        pubkey: "agent-pu",
                        eventId: "event-2",
                        timestamp: 1700000002000, // +2 seconds
                        ral: {},
                        targetedPubkeys: ["user-pub1"],
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            expect(result.success).toBe(true);
            const messages = (result.conversation as any).messages;

            // Should be a string, not an array
            expect(typeof messages).toBe("string");

            // Should contain formatted lines
            const lines = messages.split("\n");
            expect(lines).toHaveLength(2);
            expect(lines[0]).toBe("[+0] [@user-pub] Hello");
            expect(lines[1]).toBe("[+2] [@agent-pu -> @user-pub] Hi there!");
        });

        it("should not include metadata field", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                title: "Test Conversation",
                metadata: { some: "data" },
                messages: [
                    {
                        messageType: "text",
                        content: "Hello",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            expect(result.success).toBe(true);
            expect((result.conversation as any).metadata).toBeUndefined();
        });

        it("should format relative timestamps in seconds", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000, // Base
                    },
                    {
                        messageType: "text",
                        content: "Second",
                        pubkey: "user-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000010000, // +10 seconds
                    },
                    {
                        messageType: "text",
                        content: "Third",
                        pubkey: "user-pubkey",
                        eventId: "event-3",
                        timestamp: 1700000065000, // +65 seconds
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            expect(lines[0]).toContain("[+0]");
            expect(lines[1]).toContain("[+10]");
            expect(lines[2]).toContain("[+65]");
        });
    });

    describe("Arrow Syntax", () => {
        it("should show no arrow when there is no target", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "No target message",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            expect(messages).toBe("[+0] [@user-pub] No target message");
            expect(messages).not.toContain("->");
        });

        it("should show single arrow for single target", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "Single target",
                        pubkey: "sender-pk",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                        targetedPubkeys: ["target-pk"],
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            expect(messages).toBe("[+0] [@sender-p -> @target-p] Single target");
        });

        it("should show comma-separated targets for multiple targets", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "Multi target",
                        pubkey: "sender-pk",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                        targetedPubkeys: ["target-1p", "target-2p"],
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            expect(messages).toBe("[+0] [@sender-p -> @target-1, @target-2] Multi target");
        });
    });

    describe("Tool Call and Result Merging", () => {
        it("should skip tool-results by default (no merging)", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "Hello",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "tool-call",
                        content: "",
                        toolData: [{ toolName: "test_tool", input: { foo: "bar" } }],
                        pubkey: "agent-pub",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                        ral: {},
                    },
                    {
                        messageType: "tool-result",
                        content: "",
                        toolData: [{ output: "some result" }],
                        pubkey: "agent-pub",
                        eventId: "event-3",
                        timestamp: 1700000002000,
                    },
                    {
                        messageType: "text",
                        content: "Thanks!",
                        pubkey: "user-pubkey",
                        eventId: "event-4",
                        timestamp: 1700000003000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            // Should have 3 lines: text, tool-call (no result), text
            expect(lines).toHaveLength(3);
            expect(lines[0]).toContain("Hello");
            expect(lines[1]).toContain("[tool-use test_tool");
            expect(lines[1]).not.toContain("[tool-result");
            expect(lines[2]).toContain("Thanks!");
        });

        it("should merge tool-call and tool-result into single line when includeToolResults=true", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "tool-call",
                        content: "",
                        toolData: [{ toolName: "shell", input: { command: "date" } }],
                        pubkey: "agent-pub",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                        ral: {},
                    },
                    {
                        messageType: "tool-result",
                        content: "",
                        toolData: [{ output: "2020-01-01" }],
                        pubkey: "agent-pub",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                includeToolResults: true,
            });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            // Should be merged into single line
            expect(lines).toHaveLength(1);
            expect(lines[0]).toContain("[tool-use shell");
            expect(lines[0]).toContain("[tool-result");
            expect(lines[0]).toContain("2020-01-01");
        });

        it("should handle standalone tool-result when not preceded by tool-call", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "tool-result",
                        content: "",
                        toolData: [{ output: "standalone result" }],
                        pubkey: "agent-pub",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                includeToolResults: true,
            });

            const messages = (result.conversation as any).messages;
            expect(messages).toContain("[tool-result");
            expect(messages).toContain("standalone result");
        });
    });

    describe("Line Truncation (1500 char limit)", () => {
        it("should not truncate lines under 1500 chars", async () => {
            const content = "x".repeat(100);
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content,
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            expect(messages).not.toContain("[truncated");
            expect(messages).toContain(content);
        });

        it("should truncate lines over 1500 chars", async () => {
            // Create content that will make line exceed 1500 chars
            const content = "x".repeat(1600);
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content,
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            expect(messages).toContain("[truncated");
            expect(messages.length).toBeLessThan(content.length + 100); // Significantly shorter
        });

        it("should truncate tool-call + tool-result merged lines", async () => {
            // Create large tool data that will exceed 1500 chars when merged
            const largeArgs = { data: "y".repeat(800) };
            const largeResult = "z".repeat(800);

            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "tool-call",
                        content: "",
                        toolData: [{ toolName: "big_tool", input: largeArgs }],
                        pubkey: "agent-pub",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                        ral: {},
                    },
                    {
                        messageType: "tool-result",
                        content: "",
                        toolData: [{ output: largeResult }],
                        pubkey: "agent-pub",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                includeToolResults: true,
            });

            const messages = (result.conversation as any).messages;
            // Check for either line-level truncation "[truncated" or param-level truncation "(N chars truncated)"
            expect(messages).toMatch(/\[truncated|chars truncated\)/);
        });
    });

    describe("Message Count", () => {
        it("should report original message count", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "Hello",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "tool-result",
                        content: "",
                        toolData: [{ output: "result" }],
                        pubkey: "agent-pub",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                    {
                        messageType: "tool-result",
                        content: "",
                        toolData: [{ output: "result2" }],
                        pubkey: "agent-pub",
                        eventId: "event-3",
                        timestamp: 1700000002000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            // messageCount should reflect original count (3)
            expect((result.conversation as any).messageCount).toBe(3);
        });
    });

    describe("Conversation Not Found", () => {
        it("should return error when conversation not found", async () => {
            mockConversationData = null;
            mockGetConversation.mockReturnValue(null);
            mockContext.conversationId = "non-existent";

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "non-existent" });

            expect(result.success).toBe(false);
            expect(result.message).toContain("not found");
        });
    });

    describe("Multiple Tool Calls", () => {
        it("should handle multiple tool calls in sequence", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "tool-call",
                        content: "",
                        toolData: [{ toolName: "tool1", input: {} }],
                        pubkey: "agent-pub",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                        ral: {},
                    },
                    {
                        messageType: "tool-result",
                        content: "",
                        toolData: [{ output: "result1" }],
                        pubkey: "agent-pub",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                    {
                        messageType: "tool-call",
                        content: "",
                        toolData: [{ toolName: "tool2", input: {} }],
                        pubkey: "agent-pub",
                        eventId: "event-3",
                        timestamp: 1700000002000,
                        ral: {},
                    },
                    {
                        messageType: "tool-result",
                        content: "",
                        toolData: [{ output: "result2" }],
                        pubkey: "agent-pub",
                        eventId: "event-4",
                        timestamp: 1700000003000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                includeToolResults: true,
            });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            // Should merge each pair, resulting in 2 lines
            expect(lines).toHaveLength(2);
            expect(lines[0]).toContain("tool1");
            expect(lines[0]).toContain("result1");
            expect(lines[1]).toContain("tool2");
            expect(lines[1]).toContain("result2");
        });
    });
});
