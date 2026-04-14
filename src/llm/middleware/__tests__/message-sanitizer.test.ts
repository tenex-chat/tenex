import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { LanguageModelV3Message } from "@ai-sdk/provider";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import * as constantsModule from "@/constants";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const testBaseDir = join(import.meta.dir, ".test-tenex-base");

import { createMessageSanitizerMiddleware } from "../message-sanitizer";

const fakeModel: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    supportedUrls: {},
    doGenerate: async () => { throw new Error("not implemented"); },
    doStream: async () => { throw new Error("not implemented"); },
};

function makeParams(prompt: LanguageModelV3Message[]) {
    return { prompt, maxOutputTokens: 4096 };
}

describe("message-sanitizer TENEX wrapper", () => {
    let transformParams: NonNullable<ReturnType<typeof createMessageSanitizerMiddleware>["transformParams"]>;

    beforeEach(() => {
        if (existsSync(testBaseDir)) rmSync(testBaseDir, { recursive: true });
        spyOn(constantsModule, "getTenexBasePath").mockReturnValue(testBaseDir);
        transformParams = createMessageSanitizerMiddleware().transformParams!;
    });

    afterEach(() => {
        if (existsSync(testBaseDir)) rmSync(testBaseDir, { recursive: true });
        mock.restore();
    });

    test("writes structured JSON to warn.log when fix is applied", async () => {
        const prompt: LanguageModelV3Message[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
            { role: "assistant", content: [{ type: "text", text: "Trailing" }] },
        ];

        await transformParams({ params: makeParams(prompt), type: "stream", model: fakeModel });

        const logPath = join(testBaseDir, "daemon", "warn.log");
        expect(existsSync(logPath)).toBe(true);

        const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
        expect(entry.fix).toBe("trailing-assistant-stripped");
        expect(entry.model).toBe("anthropic:claude-opus-4-6");
        expect(entry.callType).toBe("stream");
        expect(entry.ts).toBeDefined();
    });

    test("does not write warn.log when no fixes needed", async () => {
        const prompt: LanguageModelV3Message[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];

        await transformParams({ params: makeParams(prompt), type: "stream", model: fakeModel });

        expect(existsSync(join(testBaseDir, "daemon", "warn.log"))).toBe(false);
    });

    test("writes multiple entries for multiple fixes", async () => {
        const prompt: LanguageModelV3Message[] = [
            { role: "user", content: [] },
            { role: "user", content: [{ type: "text", text: "Hello" }] },
            { role: "assistant", content: [{ type: "text", text: "Trailing" }] },
        ];

        await transformParams({ params: makeParams(prompt), type: "generate", model: fakeModel });

        const lines = readFileSync(join(testBaseDir, "daemon", "warn.log"), "utf-8")
            .trim()
            .split("\n");
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).fix).toBe("empty-content-stripped");
        expect(JSON.parse(lines[1]).fix).toBe("trailing-assistant-stripped");
    });

    test("wraps malformed assistant tool-call input into a dictionary", async () => {
        const prompt: LanguageModelV3Message[] = [
            {
                role: "assistant",
                content: [{
                    type: "tool-call",
                    toolCallId: "call-1",
                    toolName: "compact_context",
                    input: "{\"setEntries\": \n<parameter name=\"objective\">debug it</parameter>",
                } as LanguageModelV3Message["content"][number]],
            },
            {
                role: "tool",
                content: [{
                    type: "tool-result",
                    toolCallId: "call-1",
                    toolName: "compact_context",
                    output: { type: "text", value: "Tool execution failed" },
                } as LanguageModelV3Message["content"][number]],
            },
            { role: "user", content: [{ type: "text", text: "Continue" }] },
        ];

        const result = await transformParams({ params: makeParams(prompt), type: "stream", model: fakeModel });
        const toolCall = (result.prompt[0] as { content: Array<Record<string, unknown>> }).content[0];

        expect(toolCall.input).toEqual({
            _sanitizerInvalidInput: true,
            _sanitizerOriginalInputType: "string",
            rawInput: "{\"setEntries\": \n<parameter name=\"objective\">debug it</parameter>",
        });

        const logPath = join(testBaseDir, "daemon", "warn.log");
        const lines = readFileSync(logPath, "utf-8").trim().split("\n");
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toMatchObject({
            fix: "tool-call-input-wrapped",
            model: "anthropic:claude-opus-4-6",
            callType: "stream",
            tool_call_id: "call-1",
            tool_name: "compact_context",
            input_type: "string",
        });
    });
});
