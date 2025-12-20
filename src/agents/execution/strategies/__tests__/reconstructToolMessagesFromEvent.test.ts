import { describe, expect, it, mock } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock logger before importing the function
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        debug: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
    },
}));

import { reconstructToolMessagesFromEvent } from "../FlattenedChronologicalStrategy";

/**
 * Unit tests for reconstructToolMessagesFromEvent.
 *
 * This function reconstructs AI SDK tool-call and tool-result messages
 * from published Nostr tool events when local storage is unavailable.
 */
describe("reconstructToolMessagesFromEvent", () => {
    it("should reconstruct tool messages from valid event content", () => {
        const event = new NDKEvent();
        event.id = "abc123def456ghij";
        event.pubkey = "agent-pubkey";
        event.content = JSON.stringify({
            tool: "write_file",
            input: {
                path: "test.md",
                content: "# Test",
            },
            success: true,
            output: {
                success: true,
                message: "File written",
            },
        });
        event.kind = 1111;
        event.tags = [["tool", "write_file"]];

        const messages = reconstructToolMessagesFromEvent(event);

        expect(messages).not.toBeNull();
        expect(messages).toHaveLength(2);

        // Check tool-call message
        const toolCall = messages![0];
        expect(toolCall.role).toBe("assistant");
        expect(Array.isArray(toolCall.content)).toBe(true);

        const toolCallContent = (toolCall.content as any[])[0];
        expect(toolCallContent.type).toBe("tool-call");
        expect(toolCallContent.toolName).toBe("write_file");
        expect(toolCallContent.input).toEqual({
            path: "test.md",
            content: "# Test",
        });
        expect(toolCallContent.toolCallId).toBe("call_abc123def456ghij");

        // Check tool-result message
        const toolResult = messages![1];
        expect(toolResult.role).toBe("tool");
        expect(Array.isArray(toolResult.content)).toBe(true);

        const toolResultContent = (toolResult.content as any[])[0];
        expect(toolResultContent.type).toBe("tool-result");
        expect(toolResultContent.toolName).toBe("write_file");
        expect(toolResultContent.output.type).toBe("text");
        expect(toolResultContent.output.value).toContain("success");
    });

    it("should handle string output", () => {
        const event = new NDKEvent();
        event.id = "event123456789012";
        event.content = JSON.stringify({
            tool: "shell",
            input: { command: "ls" },
            output: "file1.txt\nfile2.txt",
        });
        event.tags = [["tool", "shell"]];

        const messages = reconstructToolMessagesFromEvent(event);

        expect(messages).not.toBeNull();
        const toolResultContent = (messages![1].content as any[])[0];
        expect(toolResultContent.output.value).toBe("file1.txt\nfile2.txt");
    });

    it("should handle undefined output", () => {
        const event = new NDKEvent();
        event.id = "event123456789012";
        event.content = JSON.stringify({
            tool: "some_tool",
            input: { param: "value" },
            // No output field
        });
        event.tags = [["tool", "some_tool"]];

        const messages = reconstructToolMessagesFromEvent(event);

        expect(messages).not.toBeNull();
        const toolResultContent = (messages![1].content as any[])[0];
        expect(toolResultContent.output.value).toBe("");
    });

    it("should return null for invalid JSON", () => {
        const event = new NDKEvent();
        event.id = "event123456789012";
        event.content = "this is not valid JSON {{{";
        event.tags = [["tool", "broken"]];

        const messages = reconstructToolMessagesFromEvent(event);

        expect(messages).toBeNull();
    });

    it("should return null when tool field is missing", () => {
        const event = new NDKEvent();
        event.id = "event123456789012";
        event.content = JSON.stringify({
            // Missing 'tool' field
            input: { path: "test.md" },
            output: { success: true },
        });
        event.tags = [["tool", "some_tool"]];

        const messages = reconstructToolMessagesFromEvent(event);

        expect(messages).toBeNull();
    });

    it("should return null when input field is missing", () => {
        const event = new NDKEvent();
        event.id = "event123456789012";
        event.content = JSON.stringify({
            tool: "write_file",
            // Missing 'input' field
            output: { success: true },
        });
        event.tags = [["tool", "write_file"]];

        const messages = reconstructToolMessagesFromEvent(event);

        expect(messages).toBeNull();
    });

    it("should handle empty input object", () => {
        const event = new NDKEvent();
        event.id = "event123456789012";
        event.content = JSON.stringify({
            tool: "no_args_tool",
            input: {},
            output: "done",
        });
        event.tags = [["tool", "no_args_tool"]];

        const messages = reconstructToolMessagesFromEvent(event);

        expect(messages).not.toBeNull();
        const toolCallContent = (messages![0].content as any[])[0];
        expect(toolCallContent.input).toEqual({});
    });

    it("should generate consistent toolCallId from event ID", () => {
        const event = new NDKEvent();
        event.id = "0123456789abcdef0123456789abcdef";
        event.content = JSON.stringify({
            tool: "test",
            input: {},
        });
        event.tags = [["tool", "test"]];

        const messages = reconstructToolMessagesFromEvent(event);

        expect(messages).not.toBeNull();
        const toolCallContent = (messages![0].content as any[])[0];
        const toolResultContent = (messages![1].content as any[])[0];

        // Both should have matching toolCallId
        expect(toolCallContent.toolCallId).toBe("call_0123456789abcdef");
        expect(toolResultContent.toolCallId).toBe("call_0123456789abcdef");
    });
});
