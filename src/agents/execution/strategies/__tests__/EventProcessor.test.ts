import { describe, expect, it, mock, beforeEach } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        debug: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
    },
}));

// Mock ToolMessageStorage
const mockLoadToolMessages = mock(async () => null);
mock.module("@/conversations/persistence/ToolMessageStorage", () => ({
    toolMessageStorage: {
        load: mockLoadToolMessages,
    },
}));

// Mock EventToModelMessage
const mockTransform = mock(async () => ({
    role: "user",
    content: "Transformed message",
}));
mock.module("@/conversations/processors/EventToModelMessage", () => ({
    EventToModelMessage: {
        transform: mockTransform,
    },
}));

// Mock content-utils
mock.module("@/conversations/utils/content-utils", () => ({
    hasReasoningTag: mock((event: NDKEvent) => {
        return event.tags?.some((t) => t[0] === "reasoning");
    }),
}));

// Mock nostr utils
mock.module("@/nostr", () => ({
    getNDK: mock(() => ({})),
}));

mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: mock(() => ({
        getName: mock(async () => "test-name"),
    })),
}));

mock.module("@/utils/nostr-entity-parser", () => ({
    extractNostrEntities: mock(() => []),
    resolveNostrEntitiesToSystemMessages: mock(async () => []),
}));

import {
    reconstructToolMessagesFromEvent,
    processEvent,
} from "../EventProcessor";

// Helper to create mock NDKEvent
function createMockEvent(overrides: Partial<NDKEvent> = {}): NDKEvent {
    const event = new NDKEvent();
    event.id = overrides.id || `event-${Math.random().toString(36).substring(7)}`;
    event.pubkey = overrides.pubkey || "default-pubkey";
    event.content = overrides.content || "";
    event.kind = overrides.kind || 1111;
    event.created_at = overrides.created_at || Math.floor(Date.now() / 1000);
    event.tags = overrides.tags || [];
    return event;
}

describe("EventProcessor", () => {
    beforeEach(() => {
        mockLoadToolMessages.mockClear();
        mockTransform.mockClear();
    });

    describe("reconstructToolMessagesFromEvent", () => {
        it("should reconstruct tool messages from valid event", () => {
            const event = createMockEvent({
                id: "abc123def456ghij",
                content: JSON.stringify({
                    tool: "write_file",
                    input: { path: "test.txt", content: "hello" },
                    output: { success: true },
                }),
                tags: [["tool", "write_file"]],
            });

            const messages = reconstructToolMessagesFromEvent(event);

            expect(messages).not.toBeNull();
            expect(messages).toHaveLength(2);

            // Tool call message
            const toolCall = messages![0];
            expect(toolCall.role).toBe("assistant");
            expect(Array.isArray(toolCall.content)).toBe(true);
            const callContent = (toolCall.content as any[])[0];
            expect(callContent.type).toBe("tool-call");
            expect(callContent.toolName).toBe("write_file");

            // Tool result message
            const toolResult = messages![1];
            expect(toolResult.role).toBe("tool");
            const resultContent = (toolResult.content as any[])[0];
            expect(resultContent.type).toBe("tool-result");
        });

        it("should generate consistent toolCallId from event ID", () => {
            const event = createMockEvent({
                id: "1234567890abcdef1234567890abcdef",
                content: JSON.stringify({
                    tool: "test",
                    input: {},
                }),
            });

            const messages = reconstructToolMessagesFromEvent(event);

            const callContent = (messages![0].content as any[])[0];
            const resultContent = (messages![1].content as any[])[0];

            expect(callContent.toolCallId).toBe("call_1234567890abcdef");
            expect(resultContent.toolCallId).toBe("call_1234567890abcdef");
        });

        it("should handle string output", () => {
            const event = createMockEvent({
                content: JSON.stringify({
                    tool: "shell",
                    input: { command: "ls" },
                    output: "file1.txt\nfile2.txt",
                }),
            });

            const messages = reconstructToolMessagesFromEvent(event);

            const resultContent = (messages![1].content as any[])[0];
            expect(resultContent.output.value).toBe("file1.txt\nfile2.txt");
        });

        it("should handle undefined output", () => {
            const event = createMockEvent({
                content: JSON.stringify({
                    tool: "test",
                    input: {},
                    // No output
                }),
            });

            const messages = reconstructToolMessagesFromEvent(event);

            const resultContent = (messages![1].content as any[])[0];
            expect(resultContent.output.value).toBe("");
        });

        it("should return null for invalid JSON", () => {
            const event = createMockEvent({
                content: "not valid json {{",
            });

            const messages = reconstructToolMessagesFromEvent(event);

            expect(messages).toBeNull();
        });

        it("should return null when tool field is missing", () => {
            const event = createMockEvent({
                content: JSON.stringify({
                    input: { path: "test" },
                    output: {},
                }),
            });

            const messages = reconstructToolMessagesFromEvent(event);

            expect(messages).toBeNull();
        });

        it("should return null when input field is missing", () => {
            const event = createMockEvent({
                content: JSON.stringify({
                    tool: "test",
                    output: {},
                }),
            });

            const messages = reconstructToolMessagesFromEvent(event);

            expect(messages).toBeNull();
        });
    });

    describe("processEvent", () => {
        it("should skip reasoning events", async () => {
            const event = createMockEvent({
                tags: [["reasoning", "true"]],
            });

            const messages = await processEvent(
                event,
                "agent-pubkey",
                "conv-123"
            );

            expect(messages).toEqual([]);
        });

        it("should process tool events from this agent", async () => {
            const toolMessages = [
                { role: "assistant" as const, content: [] },
                { role: "tool" as const, content: [] },
            ];
            mockLoadToolMessages.mockResolvedValue(toolMessages);

            const event = createMockEvent({
                pubkey: "agent-pubkey",
                tags: [["tool", "write_file"]],
            });

            const messages = await processEvent(
                event,
                "agent-pubkey",
                "conv-123"
            );

            expect(messages).toEqual(toolMessages);
        });

        it("should skip tool events from other agents", async () => {
            const event = createMockEvent({
                pubkey: "other-agent-pubkey",
                tags: [["tool", "write_file"]],
            });

            const messages = await processEvent(
                event,
                "agent-pubkey",
                "conv-123"
            );

            expect(messages).toEqual([]);
        });

        it("should reconstruct tool messages when storage misses", async () => {
            mockLoadToolMessages.mockResolvedValue(null);

            const event = createMockEvent({
                id: "toolcall12345678",
                pubkey: "agent-pubkey",
                content: JSON.stringify({
                    tool: "test_tool",
                    input: { param: "value" },
                    output: "result",
                }),
                tags: [["tool", "test_tool"]],
            });

            const messages = await processEvent(
                event,
                "agent-pubkey",
                "conv-123"
            );

            expect(messages).toHaveLength(2);
            expect(messages[0].role).toBe("assistant");
            expect(messages[1].role).toBe("tool");
        });

        it("should process regular messages via EventToModelMessage", async () => {
            mockTransform.mockResolvedValue({
                role: "user",
                content: "User message",
            });

            const event = createMockEvent({
                pubkey: "user-pubkey",
                content: "Hello agent",
            });

            const messages = await processEvent(
                event,
                "agent-pubkey",
                "conv-123"
            );

            expect(mockTransform).toHaveBeenCalled();
            expect(messages[0].content).toBe("User message");
        });

        it("should add debug prefix in debug mode", async () => {
            const toolMessages = [
                { role: "assistant" as const, content: "Tool call" },
                { role: "tool" as const, content: "Result" },
            ];
            mockLoadToolMessages.mockResolvedValue(toolMessages);

            const event = createMockEvent({
                id: "abc12345def67890",
                pubkey: "agent-pubkey",
                tags: [["tool", "test"]],
            });

            const messages = await processEvent(
                event,
                "agent-pubkey",
                "conv-123",
                true // debug = true
            );

            expect(messages[0].content).toContain("[Event abc12345");
        });

        it("should handle array of messages from transform", async () => {
            mockTransform.mockResolvedValue([
                { role: "user", content: "Message 1" },
                { role: "system", content: "Message 2" },
            ]);

            const event = createMockEvent({
                pubkey: "user-pubkey",
                content: "Hello",
            });

            const messages = await processEvent(
                event,
                "agent-pubkey",
                "conv-123"
            );

            expect(messages).toHaveLength(2);
        });
    });
});
