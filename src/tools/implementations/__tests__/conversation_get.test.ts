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
    });

    describe("Tool Results Filtering", () => {
        it("should skip tool-result messages by default", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                title: "Test Conversation",
                messages: [
                    {
                        messageType: "text",
                        content: "Hello",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000,
                    },
                    {
                        messageType: "tool-call",
                        content: "",
                        toolData: [{ toolName: "test_tool", input: { foo: "bar" } }],
                        pubkey: "agent-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001,
                        ral: {},
                    },
                    {
                        messageType: "tool-result",
                        content: "",
                        toolData: [{ output: "some result data" }],
                        pubkey: "system-pubkey",
                        eventId: "event-3",
                        timestamp: 1700000002,
                    },
                    {
                        messageType: "text",
                        content: "Thanks!",
                        pubkey: "user-pubkey",
                        eventId: "event-4",
                        timestamp: 1700000003,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            expect(result.success).toBe(true);
            const messages = (result.conversation as any).messages;

            // Should have 3 messages (text, tool-call, text) - tool-result is skipped
            expect(messages).toHaveLength(3);
            expect(messages.map((m: any) => m.messageType)).toEqual([
                "text",
                "tool-call",
                "text",
            ]);
        });

        it("should include tool-result messages when includeToolResults=true", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                title: "Test Conversation",
                messages: [
                    {
                        messageType: "text",
                        content: "Hello",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000,
                    },
                    {
                        messageType: "tool-call",
                        content: "",
                        toolData: [{ toolName: "test_tool", input: { foo: "bar" } }],
                        pubkey: "agent-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001,
                        ral: {},
                    },
                    {
                        messageType: "tool-result",
                        content: "",
                        toolData: [{ output: "some result data" }],
                        pubkey: "system-pubkey",
                        eventId: "event-3",
                        timestamp: 1700000002,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                includeToolResults: true,
            });

            expect(result.success).toBe(true);
            const messages = (result.conversation as any).messages;

            // Should have all 3 messages including tool-result
            expect(messages).toHaveLength(3);
            expect(messages.map((m: any) => m.messageType)).toEqual([
                "text",
                "tool-call",
                "tool-result",
            ]);
        });
    });

    describe("Tool Call Truncation (1.5k limit)", () => {
        it("should not truncate tool calls under 1.5k chars", async () => {
            const smallToolData = { toolName: "test", input: { small: "data" } };

            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "tool-call",
                        content: "",
                        toolData: [smallToolData],
                        pubkey: "agent-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000,
                        ral: {},
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            expect(messages[0].content).toBe(JSON.stringify([smallToolData]));
            expect(messages[0].content).not.toContain("[truncated");
        });

        it("should truncate tool calls over 1.5k chars", async () => {
            // Create tool data that exceeds 1.5k chars
            const largeInput = "x".repeat(2000);
            const largeToolData = [{ toolName: "test", input: { data: largeInput } }];
            const fullContent = JSON.stringify(largeToolData);

            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "tool-call",
                        content: "",
                        toolData: largeToolData,
                        pubkey: "agent-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000,
                        ral: {},
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            expect(messages[0].content).toContain("[truncated");
            expect(messages[0].content.length).toBeLessThan(fullContent.length);

            // Verify truncation message includes char count
            const truncatedChars = fullContent.length - 1500;
            expect(messages[0].content).toContain(`[truncated ${truncatedChars} chars]`);
        });
    });

    describe("Tool Result Truncation (10k per result, 50k total budget)", () => {
        it("should not truncate tool results under 10k chars", async () => {
            const smallResultData = [{ output: "small result" }];

            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "tool-result",
                        content: "",
                        toolData: smallResultData,
                        pubkey: "system-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                includeToolResults: true,
            });

            const messages = (result.conversation as any).messages;
            expect(messages[0].content).toBe(JSON.stringify(smallResultData));
            expect(messages[0].content).not.toContain("[truncated");
        });

        it("should truncate individual tool results over 10k chars", async () => {
            // Create result data that exceeds 10k chars
            const largeOutput = "y".repeat(15000);
            const largeResultData = [{ output: largeOutput }];
            const fullContent = JSON.stringify(largeResultData);

            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "tool-result",
                        content: "",
                        toolData: largeResultData,
                        pubkey: "system-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                includeToolResults: true,
            });

            const messages = (result.conversation as any).messages;
            expect(messages[0].content).toContain("[truncated");

            // Should be truncated to ~10k + truncation message
            const truncatedChars = fullContent.length - 10000;
            expect(messages[0].content).toContain(`[truncated ${truncatedChars} chars]`);
        });

        it("should respect 50k total budget across multiple tool results", async () => {
            // Create 6 tool results, each 10k chars = 60k total, exceeds 50k budget
            const createLargeResult = (index: number) => ({
                messageType: "tool-result" as const,
                content: "",
                toolData: [{ output: `result-${index}-${"z".repeat(9990)}` }],
                pubkey: "system-pubkey",
                eventId: `event-${index}`,
                timestamp: 1700000000 + index,
            });

            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    createLargeResult(1),
                    createLargeResult(2),
                    createLargeResult(3),
                    createLargeResult(4),
                    createLargeResult(5),
                    createLargeResult(6),
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                includeToolResults: true,
            });

            const messages = (result.conversation as any).messages;
            expect(messages).toHaveLength(6);

            // First 5 results should fit within budget (5 * 10k = 50k)
            // 6th result should show budget exhausted
            const lastMessage = messages[5];
            expect(lastMessage.content).toContain("[budget exhausted");
        });

        it("should show budget exhausted message with char count", async () => {
            // Create enough results to exhaust budget
            const largeOutput = "a".repeat(20000);
            const createLargeResult = (index: number) => ({
                messageType: "tool-result" as const,
                content: "",
                toolData: [{ output: `${index}-${largeOutput}` }],
                pubkey: "system-pubkey",
                eventId: `event-${index}`,
                timestamp: 1700000000 + index,
            });

            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    createLargeResult(1),
                    createLargeResult(2),
                    createLargeResult(3),
                    createLargeResult(4),
                    createLargeResult(5),
                    createLargeResult(6),
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                includeToolResults: true,
            });

            const messages = (result.conversation as any).messages;

            // Find the first message that shows budget exhausted
            const exhaustedMessage = messages.find((m: any) =>
                m.content.includes("[budget exhausted")
            );
            expect(exhaustedMessage).toBeDefined();
            expect(exhaustedMessage.content).toMatch(/\[budget exhausted, \d+ chars omitted\]/);
        });
    });

    describe("Message Count", () => {
        it("should report original message count even when tool results are filtered", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "Hello",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000,
                    },
                    {
                        messageType: "tool-result",
                        content: "",
                        toolData: [{ output: "result" }],
                        pubkey: "system-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001,
                    },
                    {
                        messageType: "tool-result",
                        content: "",
                        toolData: [{ output: "result2" }],
                        pubkey: "system-pubkey",
                        eventId: "event-3",
                        timestamp: 1700000002,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            // messageCount should reflect original count (3)
            expect((result.conversation as any).messageCount).toBe(3);
            // But messages array should only have 1 (the text message)
            expect((result.conversation as any).messages).toHaveLength(1);
        });
    });

    describe("Role Assignment", () => {
        it("should assign correct roles to different message types", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "User message",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000,
                    },
                    {
                        messageType: "text",
                        content: "Agent message",
                        pubkey: "agent-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001,
                        ral: {}, // Has RAL = agent message
                    },
                    {
                        messageType: "tool-call",
                        content: "",
                        toolData: [{ toolName: "test" }],
                        pubkey: "agent-pubkey",
                        eventId: "event-3",
                        timestamp: 1700000002,
                        ral: {},
                    },
                    {
                        messageType: "tool-result",
                        content: "",
                        toolData: [{ output: "result" }],
                        pubkey: "system-pubkey",
                        eventId: "event-4",
                        timestamp: 1700000003,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                includeToolResults: true,
            });

            const messages = (result.conversation as any).messages;
            expect(messages[0].role).toBe("user");      // text without ral
            expect(messages[1].role).toBe("assistant"); // text with ral
            expect(messages[2].role).toBe("assistant"); // tool-call
            expect(messages[3].role).toBe("tool");      // tool-result
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
});
