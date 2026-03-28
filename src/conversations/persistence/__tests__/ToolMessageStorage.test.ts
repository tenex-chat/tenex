import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, createTempDir } from "@/test-utils";
import { ToolMessageStorage } from "../ToolMessageStorage";

function getToolOutput(messages: Awaited<ReturnType<ToolMessageStorage["load"]>>): string | undefined {
    const toolMessage = messages?.find((message) => message.role === "tool");
    if (!toolMessage || !Array.isArray(toolMessage.content)) {
        return undefined;
    }

    const toolResult = toolMessage.content.find(
        (part) => typeof part === "object" && "type" in part && part.type === "tool-result"
    );
    if (!toolResult || !("output" in toolResult)) {
        return undefined;
    }

    const output = toolResult.output;
    if (typeof output === "string") {
        return output;
    }
    if (output && typeof output === "object" && "value" in output) {
        return typeof output.value === "string" ? output.value : JSON.stringify(output.value);
    }

    return undefined;
}

function getToolInput(messages: Awaited<ReturnType<ToolMessageStorage["load"]>>): unknown {
    const assistantMessage = messages?.find((message) => message.role === "assistant");
    if (!assistantMessage || !Array.isArray(assistantMessage.content)) {
        return undefined;
    }

    const toolCall = assistantMessage.content.find(
        (part) => typeof part === "object" && "type" in part && part.type === "tool-call"
    );
    return toolCall && "input" in toolCall ? toolCall.input : undefined;
}

describe("ToolMessageStorage", () => {
    let tempDir: string;
    let storage: ToolMessageStorage;

    beforeEach(async () => {
        tempDir = await createTempDir("tenex-tool-storage-");
        storage = new ToolMessageStorage(join(tempDir, "tool-messages"));
    });

    afterEach(async () => {
        await cleanupTempDir(tempDir);
    });

    it("stores the same toolCallId separately for different conversations", async () => {
        const toolCallId = "tool:call/1";

        await storage.store(
            "conversation/one",
            {
                toolCallId,
                toolName: "fs_read",
                input: { path: "/tmp/one.ts" },
            },
            {
                toolCallId,
                toolName: "fs_read",
                output: "first result",
            },
            "agent-pubkey"
        );

        await storage.store(
            "conversation/two",
            {
                toolCallId,
                toolName: "fs_read",
                input: { path: "/tmp/two.ts" },
            },
            {
                toolCallId,
                toolName: "fs_read",
                output: "second result",
            },
            "agent-pubkey"
        );

        const firstMessages = await storage.load("conversation/one", toolCallId);
        const secondMessages = await storage.load("conversation/two", toolCallId);

        expect(getToolInput(firstMessages)).toEqual({ path: "/tmp/one.ts" });
        expect(getToolOutput(firstMessages)).toBe("first result");
        expect(getToolInput(secondMessages)).toEqual({ path: "/tmp/two.ts" });
        expect(getToolOutput(secondMessages)).toBe("second result");

        const firstPath = join(
            tempDir,
            "tool-messages",
            encodeURIComponent("conversation/one"),
            `${encodeURIComponent(toolCallId)}.json`
        );
        const secondPath = join(
            tempDir,
            "tool-messages",
            encodeURIComponent("conversation/two"),
            `${encodeURIComponent(toolCallId)}.json`
        );

        expect(await stat(firstPath)).toBeDefined();
        expect(await stat(secondPath)).toBeDefined();
    });

    it("returns null when a toolCallId exists only in another conversation", async () => {
        await storage.store(
            "conversation-a",
            {
                toolCallId: "shared-call",
                toolName: "shell",
                input: { command: "pwd" },
            },
            {
                toolCallId: "shared-call",
                toolName: "shell",
                output: "/tmp/project",
            },
            "agent-pubkey"
        );

        expect(await storage.load("conversation-b", "shared-call")).toBeNull();
    });
});
