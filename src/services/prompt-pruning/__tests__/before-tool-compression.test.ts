import { describe, expect, it } from "bun:test";
import type { PromptToolCompressionPlanEntry } from "ai-sdk-context-management";
import { beforeToolCompression } from "../before-tool-compression";

function createEntry(overrides: Partial<PromptToolCompressionPlanEntry>): PromptToolCompressionPlanEntry {
    return {
        message: {
            id: "msg-1",
            role: "tool",
            entryType: "tool-result",
            content: "tool output",
            toolCallId: "call-1",
            toolName: "fs_read",
        },
        messageIndex: 0,
        entryType: "tool-result",
        toolName: "fs_read",
        toolCallId: "call-1",
        exchangePositionFromEnd: 2,
        combinedTokens: 200,
        decision: { policy: "truncate", maxTokens: 48 },
        ...overrides,
    };
}

describe("beforeToolCompression", () => {
    it("keeps delegate tool results verbatim", () => {
        const entries = [
            createEntry({
                toolName: "delegate_followup",
                message: {
                    id: "msg-1",
                    role: "tool",
                    entryType: "tool-result",
                    content: "delegation transcript",
                    toolCallId: "call-1",
                    toolName: "delegate_followup",
                },
            }),
        ];

        expect(beforeToolCompression(entries)[0]?.decision).toEqual({ policy: "keep" });
    });

    it("keeps MCP-wrapped delegate tool results verbatim", () => {
        const entries = [
            createEntry({
                toolName: "mcp__tenex__delegate",
                message: {
                    id: "msg-1",
                    role: "tool",
                    entryType: "tool-result",
                    content: "delegation transcript",
                    toolCallId: "call-1",
                    toolName: "mcp__tenex__delegate",
                },
            }),
        ];

        expect(beforeToolCompression(entries)[0]?.decision).toEqual({ policy: "keep" });
    });

    it("leaves non-delegate tool decisions unchanged", () => {
        const entries = [createEntry({})];

        expect(beforeToolCompression(entries)[0]?.decision).toEqual({ policy: "truncate", maxTokens: 48 });
    });
});
