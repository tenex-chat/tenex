import { beforeEach, describe, expect, it, mock } from "bun:test";

const mockLoad = mock();

mock.module("@/conversations/persistence/ToolMessageStorage", () => ({
    toolMessageStorage: {
        load: mockLoad,
    },
}));

import { executeReadToolResult } from "../fs-hooks";

describe("executeReadToolResult", () => {
    beforeEach(() => {
        mockLoad.mockClear();
        mockLoad.mockImplementation(() => Promise.resolve(null));
    });

    it("loads tool results from the current conversation and formats them", async () => {
        mockLoad.mockResolvedValue([
            {
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        toolCallId: "call-1",
                        toolName: "fs_read",
                        input: { path: "/tmp/example.ts" },
                    },
                ],
            },
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId: "call-1",
                        toolName: "fs_read",
                        output: { type: "text", value: "console.log('hello');" },
                    },
                ],
            },
        ]);

        const result = await executeReadToolResult("conversation-1", "call-1");

        expect(mockLoad).toHaveBeenCalledWith("conversation-1", "call-1");
        expect(result).toContain("Tool: fs_read");
        expect(result).toContain("Conversation ID: conversation-1");
        expect(result).toContain("Tool Call ID: call-1");
        expect(result).toContain('"path": "/tmp/example.ts"');
        expect(result).toContain("console.log('hello');");
    });

    it("throws when the tool result is missing from the current conversation", async () => {
        mockLoad.mockResolvedValue(null);

        await expect(
            executeReadToolResult("conversation-2", "call-1")
        ).rejects.toThrow(
            "No tool result found for conversation ID: conversation-2, tool call ID: call-1"
        );
    });
});
