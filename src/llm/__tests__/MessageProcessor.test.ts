import { describe, expect, mock, test, beforeEach } from "bun:test";
import type { ModelMessage } from "ai";

const mockWarn = mock(() => {});

mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: mockWarn,
        error: () => {},
    },
}));

const { stripTrailingAssistantMessages } = await import("../MessageProcessor");

describe("stripTrailingAssistantMessages", () => {
    beforeEach(() => {
        mockWarn.mockClear();
    });

    test("returns messages unchanged when last message is user role", () => {
        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
            { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
            { role: "user", content: [{ type: "text", text: "How are you?" }] },
        ];

        const result = stripTrailingAssistantMessages(messages);

        expect(result).toEqual(messages);
        expect(result).toBe(messages); // Same reference — no copy needed
        expect(mockWarn).not.toHaveBeenCalled();
    });

    test("returns messages unchanged when last message is tool role", () => {
        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
            { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "test", args: {} }] },
            { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "test", result: "done" }] },
        ];

        const result = stripTrailingAssistantMessages(messages);

        expect(result).toEqual(messages);
        expect(result).toBe(messages);
        expect(mockWarn).not.toHaveBeenCalled();
    });

    test("strips a single trailing assistant message", () => {
        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
            { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
            { role: "user", content: [{ type: "text", text: "Do something" }] },
            { role: "assistant", content: [{ type: "text", text: "Sure, I did it" }] },
        ];

        const result = stripTrailingAssistantMessages(messages);

        expect(result).toHaveLength(3);
        expect(result[result.length - 1].role).toBe("user");
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn.mock.calls[0][0]).toContain("Stripped 1 trailing assistant message(s)");
    });

    test("strips multiple consecutive trailing assistant messages", () => {
        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
            { role: "assistant", content: [{ type: "text", text: "Response 1" }] },
            { role: "assistant", content: [{ type: "text", text: "Response 2" }] },
        ];

        const result = stripTrailingAssistantMessages(messages);

        expect(result).toHaveLength(1);
        expect(result[0].role).toBe("user");
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn.mock.calls[0][0]).toContain("Stripped 2 trailing assistant message(s)");
    });

    test("handles empty message array", () => {
        const messages: ModelMessage[] = [];

        const result = stripTrailingAssistantMessages(messages);

        expect(result).toEqual([]);
        expect(result).toBe(messages);
        expect(mockWarn).not.toHaveBeenCalled();
    });

    test("handles array of only assistant messages", () => {
        const messages: ModelMessage[] = [
            { role: "assistant", content: [{ type: "text", text: "A" }] },
            { role: "assistant", content: [{ type: "text", text: "B" }] },
        ];

        const result = stripTrailingAssistantMessages(messages);

        expect(result).toHaveLength(0);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn.mock.calls[0][0]).toContain("Stripped 2 trailing assistant message(s)");
    });

    test("does not strip non-trailing assistant messages", () => {
        const messages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
            { role: "assistant", content: [{ type: "text", text: "I'll help" }] },
            { role: "user", content: [{ type: "text", text: "Thanks" }] },
            { role: "assistant", content: [{ type: "text", text: "You're welcome" }] },
            { role: "user", content: [{ type: "text", text: "Bye" }] },
        ];

        const result = stripTrailingAssistantMessages(messages);

        expect(result).toHaveLength(5);
        expect(result).toBe(messages);
        expect(mockWarn).not.toHaveBeenCalled();
    });

    test("preserves message content when stripping", () => {
        const userMsg: ModelMessage = { role: "user", content: [{ type: "text", text: "Keep me" }] };
        const assistantMsg: ModelMessage = { role: "assistant", content: [{ type: "text", text: "Strip me" }] };
        const messages = [userMsg, assistantMsg];

        const result = stripTrailingAssistantMessages(messages);

        expect(result).toHaveLength(1);
        expect(result[0]).toBe(userMsg); // Same object reference preserved
    });

    test("simulates post-compression scenario with compressed summary + trailing assistant", () => {
        // After compression: compressed summary (user role) + remaining uncompressed messages
        // The last of which can be an assistant turn
        const messages: ModelMessage[] = [
            {
                role: "user",
                content: [{ type: "text", text: "[Compressed Summary]\nThe conversation covered setup and configuration..." }],
            },
            { role: "user", content: [{ type: "text", text: "Now do the next task" }] },
            { role: "assistant", content: [{ type: "text", text: "Sure, I completed the task." }] },
        ];

        const result = stripTrailingAssistantMessages(messages);

        expect(result).toHaveLength(2);
        expect(result[result.length - 1].role).toBe("user");
        expect(mockWarn).toHaveBeenCalledTimes(1);
    });
});
