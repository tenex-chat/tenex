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

// Mock agent registry - simulates known agents in the system
const mockAgentPubkeyToSlug: Map<string, string> = new Map([
    ["agent-pubkey-claude-code", "claude-code"],
    ["agent-pubkey-architect", "architect-orchestrator"],
    ["agent-pubkey-debugger", "debugger"],
]);

// Mock PubkeyService - returns agent slug for known agents, truncated pubkey otherwise
mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getNameSync: (pk: string) => {
            // Return agent slug if this pubkey belongs to a registered agent
            const agentSlug = mockAgentPubkeyToSlug.get(pk);
            if (agentSlug) {
                return agentSlug;
            }
            // Fall back to truncated pubkey (PREFIX_LENGTH = 12)
            return pk.slice(0, 12);
        },
    }),
}));

// Mock PrefixKVStore
const mockPrefixLookup = mock((prefix: string) => {
    // Return predefined mappings for test prefixes
    const mappings: Record<string, string> = {
        "abc123def456": "abc123def456789012345678901234567890123456789012345678901234",
        "event1234567": "event123456789012345678901234567890123456789012345678901234",
    };
    return mappings[prefix] ?? null;
});

const mockPrefixStoreIsInitialized = mock(() => true);

mock.module("@/services/storage", () => ({
    prefixKVStore: {
        lookup: mockPrefixLookup,
        isInitialized: mockPrefixStoreIsInitialized,
    },
}));

// Mock llmServiceFactory
mock.module("@/llm", () => ({
    llmServiceFactory: {
        createService: mock(),
    },
}));

// Mock RAGService to avoid initialization errors
mock.module("@/services/rag/RAGService", () => ({
    RAGService: {
        getInstance: mock(() => ({
            initialize: mock(() => Promise.resolve()),
        })),
    },
}));

// Mock ConversationEmbeddingService to avoid RAGService initialization
mock.module("@/conversations/search/embeddings/ConversationEmbeddingService", () => ({
    ConversationEmbeddingService: {
        getInstance: mock(() => ({
            initialize: mock(() => Promise.resolve()),
            indexConversation: mock(() => Promise.resolve()),
        })),
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
                        pubkey: "user-pub1234abcdef", // 12+ chars for truncation test
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Hi there!",
                        pubkey: "agent-pu1234abcdef", // 12+ chars for truncation test
                        eventId: "event-2",
                        timestamp: 1700000002000, // +2 seconds
                        ral: {},
                        targetedPubkeys: ["user-pub1234abcdef"],
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
            expect(lines[0]).toBe("[+0] [@user-pub1234] Hello");
            expect(lines[1]).toBe("[+2] [@agent-pu1234 -> @user-pub1234] Hi there!");
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
                        pubkey: "user-pubkey123456", // 16 chars - truncated to 12
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            expect(messages).toBe("[+0] [@user-pubkey1] No target message");
            expect(messages).not.toContain("->");
        });

        it("should show single arrow for single target", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "Single target",
                        pubkey: "sender-pk123456", // 15 chars - truncated to 12
                        eventId: "event-1",
                        timestamp: 1700000000000,
                        targetedPubkeys: ["target-pk123456"], // 15 chars - truncated to 12
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            expect(messages).toBe("[+0] [@sender-pk123 -> @target-pk123] Single target");
        });

        it("should show comma-separated targets for multiple targets", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "Multi target",
                        pubkey: "sender-pk123456", // 15 chars - truncated to 12
                        eventId: "event-1",
                        timestamp: 1700000000000,
                        targetedPubkeys: ["target-1pk12345", "target-2pk12345"], // 15 chars each - truncated to 12
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            expect(messages).toBe("[+0] [@sender-pk123 -> @target-1pk12, @target-2pk12] Multi target");
        });
    });

    describe("Tool Call and Result Merging", () => {
        it("should skip tool-calls and tool-results by default (includeToolResults=false)", async () => {
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

            // Should have only 2 lines: text messages only (no tool-call or tool-result)
            expect(lines).toHaveLength(2);
            expect(lines[0]).toContain("Hello");
            expect(lines[0]).not.toContain("[tool-use");
            expect(lines[1]).toContain("Thanks!");
            expect(messages).not.toContain("[tool-use");
            expect(messages).not.toContain("[tool-result");
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

    describe("Pubkey Fallback Regression", () => {
        it("should fall back to truncated pubkey (12 chars) for uncached pubkeys - never 'User'", async () => {
            // This test prevents regression to the original bug where uncached pubkeys
            // would be displayed as "User" instead of their truncated pubkey.
            // The mock PubkeyService.getNameSync returns pk.slice(0, 12) to simulate
            // the real behavior of returning PREFIX_LENGTH-truncated pubkeys.
            const uncachedPubkey = "abc123def456789xyz"; // 18 chars - longer than PREFIX_LENGTH
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "Message from uncached user",
                        pubkey: uncachedPubkey,
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;

            // CRITICAL: Should NEVER show "User" - must show truncated pubkey
            expect(messages).not.toContain("@User");
            expect(messages).not.toContain("[@User]");

            // Should show the first 12 characters of the pubkey (PREFIX_LENGTH)
            // "abc123def456789xyz" -> "abc123def456"
            expect(messages).toContain("@abc123def456");
            expect(messages).toBe("[+0] [@abc123def456] Message from uncached user");
        });

        it("should handle multiple uncached pubkeys with distinct truncated names", async () => {
            // Verifies that different uncached pubkeys get their own truncated identifiers
            const pubkey1 = "user1abcdef123456789";
            const pubkey2 = "user2zyxwvu987654321";
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First message",
                        pubkey: pubkey1,
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Reply",
                        pubkey: pubkey2,
                        eventId: "event-2",
                        timestamp: 1700000001000,
                        ral: {},
                        targetedPubkeys: [pubkey1],
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            // Both should use truncated pubkeys, not "User"
            expect(lines[0]).toBe("[+0] [@user1abcdef1] First message");
            expect(lines[1]).toBe("[+1] [@user2zyxwvu9 -> @user1abcdef1] Reply");

            // Double-check no "User" anywhere
            expect(messages).not.toContain("@User");
        });
    });

    describe("untilId Parameter", () => {
        it("should return all messages when untilId is not provided", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Second",
                        pubkey: "user-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                    {
                        messageType: "text",
                        content: "Third",
                        pubkey: "user-pubkey",
                        eventId: "event-3",
                        timestamp: 1700000002000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            expect(lines).toHaveLength(3);
            expect(lines[0]).toContain("First");
            expect(lines[1]).toContain("Second");
            expect(lines[2]).toContain("Third");
        });

        it("should return messages up to and including untilId", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Second",
                        pubkey: "user-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                    {
                        messageType: "text",
                        content: "Third",
                        pubkey: "user-pubkey",
                        eventId: "event-3",
                        timestamp: 1700000002000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                untilId: "event-2",
            });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            // Should only have first two messages (up to and including event-2)
            expect(lines).toHaveLength(2);
            expect(lines[0]).toContain("First");
            expect(lines[1]).toContain("Second");
            expect(messages).not.toContain("Third");
        });

        it("should return single message when untilId is first message", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Second",
                        pubkey: "user-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                untilId: "event-1",
            });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            expect(lines).toHaveLength(1);
            expect(lines[0]).toContain("First");
            expect(messages).not.toContain("Second");
        });

        it("should return all messages when untilId is last message", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Second",
                        pubkey: "user-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                untilId: "event-2",
            });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            expect(lines).toHaveLength(2);
            expect(lines[0]).toContain("First");
            expect(lines[1]).toContain("Second");
        });

        it("should return all messages when untilId is not found (graceful fallback)", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Second",
                        pubkey: "user-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                untilId: "non-existent-event-id",
            });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            // Should return all messages when untilId not found
            expect(lines).toHaveLength(2);
            expect(lines[0]).toContain("First");
            expect(lines[1]).toContain("Second");
        });

        it("should work with includeToolResults parameter", async () => {
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
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                untilId: "event-3",
                includeToolResults: true,
            });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            // Should have 2 lines: "Hello" and merged tool-call/tool-result (up to event-3)
            expect(lines).toHaveLength(2);
            expect(lines[0]).toContain("Hello");
            expect(lines[1]).toContain("[tool-use test_tool");
            expect(lines[1]).toContain("[tool-result");
            expect(messages).not.toContain("Thanks!");
        });

        it("should filter correctly with tool-call merging when untilId is tool-call", async () => {
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
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                untilId: "event-2",
                includeToolResults: true,
            });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            // Should have 2 lines: "Hello" and tool-call (without merged result since event-3 is excluded)
            expect(lines).toHaveLength(2);
            expect(lines[0]).toContain("Hello");
            expect(lines[1]).toContain("[tool-use test_tool");
            // The result should not be merged since event-3 is after untilId
            expect(lines[1]).not.toContain("[tool-result");
        });

        it("should correctly report messageCount for filtered conversation", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Second",
                        pubkey: "user-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                    {
                        messageType: "text",
                        content: "Third",
                        pubkey: "user-pubkey",
                        eventId: "event-3",
                        timestamp: 1700000002000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                untilId: "event-2",
            });

            // messageCount should reflect filtered count (2)
            expect((result.conversation as any).messageCount).toBe(2);
        });
    });

    describe("Agent Name Resolution", () => {
        it("should resolve agent pubkeys to their slugs", async () => {
            // Uses pubkeys registered in mockAgentPubkeyToSlug
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "Starting the task",
                        pubkey: "agent-pubkey-claude-code", // Registered agent
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "I'll handle architecture",
                        pubkey: "agent-pubkey-architect", // Another registered agent
                        eventId: "event-2",
                        timestamp: 1700000001000,
                        targetedPubkeys: ["agent-pubkey-claude-code"],
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            // Should show agent slugs, NOT truncated pubkeys
            expect(lines[0]).toBe("[+0] [@claude-code] Starting the task");
            expect(lines[1]).toBe("[+1] [@architect-orchestrator -> @claude-code] I'll handle architecture");

            // Should NOT contain truncated pubkeys for registered agents
            expect(messages).not.toContain("agent-pubkey");
        });

        it("should handle mixed agent and user messages", async () => {
            const userPubkey = "user123456789abcdef"; // 18 chars - not registered
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "Hello agents",
                        pubkey: userPubkey, // Human user (not registered)
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Hi! I can help",
                        pubkey: "agent-pubkey-claude-code", // Registered agent
                        eventId: "event-2",
                        timestamp: 1700000001000,
                        targetedPubkeys: [userPubkey],
                    },
                    {
                        messageType: "text",
                        content: "Investigating...",
                        pubkey: "agent-pubkey-debugger", // Another registered agent
                        eventId: "event-3",
                        timestamp: 1700000002000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({ conversationId: "test-conversation-id" });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            // User should show truncated pubkey (first 12 chars)
            expect(lines[0]).toBe("[+0] [@user12345678] Hello agents");
            // Agents should show their slugs
            expect(lines[1]).toBe("[+1] [@claude-code -> @user12345678] Hi! I can help");
            expect(lines[2]).toBe("[+2] [@debugger] Investigating...");
        });
    });

    describe("untilId Format Support", () => {
        it("should accept full 64-character hex IDs", async () => {
            const fullHexId = "event123456789012345678901234567890123456789012345678901234";
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First",
                        pubkey: "user-pubkey",
                        eventId: fullHexId,
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Second",
                        pubkey: "user-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                untilId: fullHexId,
            });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            expect(lines).toHaveLength(1);
            expect(lines[0]).toContain("First");
            expect(messages).not.toContain("Second");
        });

        it("should accept and resolve 12-character hex prefixes via PrefixKVStore", async () => {
            const fullEventId = "abc123def456789012345678901234567890123456789012345678901234";
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First",
                        pubkey: "user-pubkey",
                        eventId: fullEventId,
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Second",
                        pubkey: "user-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                untilId: "abc123def456", // 12-char prefix
            });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            // Should resolve prefix and filter correctly
            expect(lines).toHaveLength(1);
            expect(lines[0]).toContain("First");
            expect(messages).not.toContain("Second");
        });

        it("should gracefully fallback when prefix cannot be resolved", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Second",
                        pubkey: "user-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                untilId: "999999999999", // Unresolvable prefix
            });

            // Should return all messages (graceful fallback)
            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");
            expect(lines).toHaveLength(2);
            expect(lines[0]).toContain("First");
            expect(lines[1]).toContain("Second");
        });

        it("should handle prefix store not initialized", async () => {
            // Temporarily mock store as uninitialized
            mockPrefixStoreIsInitialized.mockReturnValueOnce(false);

            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Second",
                        pubkey: "user-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                untilId: "abc123def456", // 12-char prefix
            });

            // Should return all messages (graceful fallback when store not initialized)
            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");
            expect(lines).toHaveLength(2);
        });

        it("should accept NIP-19 note1 format", async () => {
            // note1 encodes a full hex event ID
            // For testing, we'll use a real note1 encoding
            const hexEventId = "0000000000000000000000000000000000000000000000000000000000000001";
            // note1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqgfjq9j
            const note1Id = "note1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqgfjq9j";

            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First",
                        pubkey: "user-pubkey",
                        eventId: hexEventId,
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Second",
                        pubkey: "user-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                untilId: note1Id,
            });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            expect(lines).toHaveLength(1);
            expect(lines[0]).toContain("First");
            expect(messages).not.toContain("Second");
        });

        it("should accept nostr: prefixed IDs", async () => {
            const fullHexId = "event123456789012345678901234567890123456789012345678901234";
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First",
                        pubkey: "user-pubkey",
                        eventId: fullHexId,
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Second",
                        pubkey: "user-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                untilId: `nostr:${fullHexId}`,
            });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            expect(lines).toHaveLength(1);
            expect(lines[0]).toContain("First");
        });

        it("should handle invalid untilId format gracefully", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First",
                        pubkey: "user-pubkey",
                        eventId: "event-1",
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Second",
                        pubkey: "user-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                untilId: "invalid-format", // Invalid format
            });

            // Should return all messages (graceful fallback)
            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");
            expect(lines).toHaveLength(2);
        });

        it("should handle case-insensitive hex IDs", async () => {
            const lowerCaseId = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
            const upperCaseId = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";

            mockConversationData = {
                id: "test-conversation-id",
                messages: [
                    {
                        messageType: "text",
                        content: "First",
                        pubkey: "user-pubkey",
                        eventId: lowerCaseId,
                        timestamp: 1700000000000,
                    },
                    {
                        messageType: "text",
                        content: "Second",
                        pubkey: "user-pubkey",
                        eventId: "event-2",
                        timestamp: 1700000001000,
                    },
                ],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "test-conversation-id",
                untilId: upperCaseId, // Uppercase version
            });

            const messages = (result.conversation as any).messages;
            const lines = messages.split("\n");

            // Should match case-insensitively
            expect(lines).toHaveLength(1);
            expect(lines[0]).toContain("First");
        });
    });

    describe("conversationId Format Support", () => {
        it("should reject invalid conversationId format", async () => {
            mockConversationData = {
                id: "test-conversation-id",
                messages: [],
            };

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "invalid-format", // Invalid format
            });

            expect(result.success).toBe(false);
            expect(result.message).toContain("Could not resolve");
        });

        it("should accept 12-char prefix for conversationId", async () => {
            const fullConvId = "abc123def456789012345678901234567890123456789012345678901234";
            mockConversationData = {
                id: fullConvId,
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

            // Override getConversation to handle prefix lookup
            mockGetConversation.mockImplementation((id?: string) => {
                if (id === fullConvId || id === "abc123def456") {
                    return mockConversationData ? {
                        id: mockConversationData.id,
                        title: mockConversationData.title,
                        metadata: mockConversationData.metadata,
                        executionTime: mockConversationData.executionTime,
                        getAllMessages: mockGetAllMessages,
                        getMessageCount: mockGetMessageCount,
                    } : null;
                }
                return null;
            });

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: "abc123def456", // 12-char prefix
            });

            expect(result.success).toBe(true);
            expect((result.conversation as any).messages).toContain("Hello");
        });

        it("should accept full 64-char hex for conversationId", async () => {
            const fullConvId = "abc123def456789012345678901234567890123456789012345678901234";
            mockConversationData = {
                id: fullConvId,
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

            mockGetConversation.mockImplementation((id?: string) => {
                if (id === fullConvId) {
                    return mockConversationData ? {
                        id: mockConversationData.id,
                        title: mockConversationData.title,
                        metadata: mockConversationData.metadata,
                        executionTime: mockConversationData.executionTime,
                        getAllMessages: mockGetAllMessages,
                        getMessageCount: mockGetMessageCount,
                    } : null;
                }
                return null;
            });

            const tool = createConversationGetTool(mockContext);
            const result = await tool.execute({
                conversationId: fullConvId,
            });

            expect(result.success).toBe(true);
            expect((result.conversation as any).messages).toContain("Hello");
        });
    });
});
