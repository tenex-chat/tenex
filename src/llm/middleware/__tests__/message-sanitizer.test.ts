import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { LanguageModelV3Message } from "@ai-sdk/provider";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";

// Use a temp dir for warn.log in tests
const testBaseDir = join(import.meta.dir, ".test-tenex-base");

// Mock getTenexBasePath to use test directory
mock.module("@/constants", () => ({
    getTenexBasePath: () => testBaseDir,
    TENEX_DIR: ".tenex",
    CONFIG_FILE: "config.json",
    MCP_CONFIG_FILE: "mcp.json",
    LLMS_FILE: "llms.json",
    PROVIDERS_FILE: "providers.json",
}));

// Track OTel span events
let spanEvents: Array<{ name: string; attributes?: Record<string, unknown> }> = [];

const mockSpan = {
    addEvent: (name: string, attributes?: Record<string, unknown>) => {
        spanEvents.push({ name, attributes });
    },
    setAttribute: mock(() => {}),
    setStatus: mock(() => {}),
    end: mock(() => {}),
    isRecording: () => true,
    recordException: mock(() => {}),
    updateName: mock(() => {}),
    setAttributes: mock(() => {}),
    spanContext: () => ({ traceId: "test", spanId: "test", traceFlags: 0 }),
};
const mockContext = {
    getValue: () => undefined,
    setValue: () => mockContext,
    deleteValue: () => mockContext,
};

mock.module("@opentelemetry/api", () => ({
    createContextKey: mock((name: string) => Symbol.for(name)),
    DiagLogLevel: { NONE: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4, VERBOSE: 5, ALL: 6 },
    diag: {
        setLogger: mock(() => {}),
        debug: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
        info: mock(() => {}),
    },
    SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 },
    ROOT_CONTEXT: mockContext,
    trace: {
        getActiveSpan: () => mockSpan,
        getTracer: () => ({
            startSpan: () => mockSpan,
            startActiveSpan: (_name: string, fn: (span: typeof mockSpan) => unknown) => fn(mockSpan),
        }),
        setSpan: () => mockContext,
    },
    SpanStatusCode: { ERROR: 2, OK: 1 },
    TraceFlags: { NONE: 0, SAMPLED: 1 },
    context: {
        active: () => mockContext,
        with: (_ctx: unknown, fn: () => unknown) => fn(),
    },
}));

// Mock logger (needed by transitive imports from test-setup preload)
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
        debug: mock(() => {}),
    },
}));

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
    return {
        prompt,
        maxOutputTokens: 4096,
    };
}

describe("message-sanitizer middleware", () => {
    beforeEach(() => {
        spanEvents = [];
        // Clean up test dir
        if (existsSync(testBaseDir)) {
            rmSync(testBaseDir, { recursive: true });
        }
    });

    afterEach(() => {
        if (existsSync(testBaseDir)) {
            rmSync(testBaseDir, { recursive: true });
        }
    });

    const middleware = createMessageSanitizerMiddleware();
    const transformParams = middleware.transformParams!;

    describe("trailing assistant messages", () => {
        test("strips a single trailing assistant message", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "system", content: "You are a helpful assistant" },
                { role: "user", content: [{ type: "text", text: "Hello" }] },
                { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
            ];

            const result = await transformParams({
                params: makeParams(prompt),
                type: "stream",
                model: fakeModel,
            });

            expect(result.prompt).toHaveLength(2);
            expect(result.prompt[0].role).toBe("system");
            expect(result.prompt[1].role).toBe("user");
        });

        test("strips multiple consecutive trailing assistant messages", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [{ type: "text", text: "Hello" }] },
                { role: "assistant", content: [{ type: "text", text: "Response 1" }] },
                { role: "assistant", content: [{ type: "text", text: "Response 2" }] },
            ];

            const result = await transformParams({
                params: makeParams(prompt),
                type: "generate",
                model: fakeModel,
            });

            expect(result.prompt).toHaveLength(1);
            expect(result.prompt[0].role).toBe("user");
        });

        test("does not strip non-trailing assistant messages", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [{ type: "text", text: "Hello" }] },
                { role: "assistant", content: [{ type: "text", text: "Hi" }] },
                { role: "user", content: [{ type: "text", text: "How are you?" }] },
            ];

            const result = await transformParams({
                params: makeParams(prompt),
                type: "stream",
                model: fakeModel,
            });

            // No change — last message is user
            expect(result.prompt).toHaveLength(3);
            expect(result.prompt).toEqual(prompt);
        });
    });

    describe("empty content messages", () => {
        test("strips user messages with empty content array", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "system", content: "You are helpful" },
                { role: "user", content: [] },
                { role: "user", content: [{ type: "text", text: "Real question" }] },
            ];

            const result = await transformParams({
                params: makeParams(prompt),
                type: "stream",
                model: fakeModel,
            });

            expect(result.prompt).toHaveLength(2);
            expect(result.prompt[0].role).toBe("system");
            expect(result.prompt[1].role).toBe("user");
            expect((result.prompt[1] as { role: "user"; content: Array<{ type: string; text: string }> }).content[0].text).toBe("Real question");
        });

        test("strips assistant messages with empty content array", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [{ type: "text", text: "Hello" }] },
                { role: "assistant", content: [] },
                { role: "user", content: [{ type: "text", text: "Still here?" }] },
            ];

            const result = await transformParams({
                params: makeParams(prompt),
                type: "stream",
                model: fakeModel,
            });

            expect(result.prompt).toHaveLength(2);
            expect(result.prompt[0].role).toBe("user");
            expect(result.prompt[1].role).toBe("user");
        });
    });

    describe("tool messages are never stripped", () => {
        test("preserves tool messages even with minimal content", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [{ type: "text", text: "Use a tool" }] },
                {
                    role: "assistant",
                    content: [{
                        type: "tool-call",
                        toolCallId: "call-1",
                        toolName: "search",
                        input: { query: "test" },
                    }],
                },
                {
                    role: "tool",
                    content: [{
                        type: "tool-result",
                        toolCallId: "call-1",
                        toolName: "search",
                        output: { type: "text", value: "result" },
                    }],
                },
            ];

            const result = await transformParams({
                params: makeParams(prompt),
                type: "stream",
                model: fakeModel,
            });

            // No changes — all messages are valid
            expect(result.prompt).toHaveLength(3);
            expect(result.prompt).toEqual(prompt);
        });
    });

    describe("system messages are never stripped", () => {
        test("preserves system messages with empty string content", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "system", content: "" },
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ];

            const result = await transformParams({
                params: makeParams(prompt),
                type: "stream",
                model: fakeModel,
            });

            expect(result.prompt).toHaveLength(2);
            expect(result.prompt[0].role).toBe("system");
        });

        test("preserves system messages with content", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "system", content: "You are helpful" },
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ];

            const result = await transformParams({
                params: makeParams(prompt),
                type: "generate",
                model: fakeModel,
            });

            // No changes needed
            expect(result.prompt).toEqual(prompt);
        });
    });

    describe("warn log", () => {
        test("writes structured JSON to warn.log when fixes are applied", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [{ type: "text", text: "Hello" }] },
                { role: "assistant", content: [{ type: "text", text: "Trailing" }] },
            ];

            await transformParams({
                params: makeParams(prompt),
                type: "stream",
                model: fakeModel,
            });

            const logPath = join(testBaseDir, "daemon", "warn.log");
            expect(existsSync(logPath)).toBe(true);

            const logContent = readFileSync(logPath, "utf-8").trim();
            const entry = JSON.parse(logContent);

            expect(entry.type).toBe("message-sanitizer");
            expect(entry.fix).toBe("trailing-assistant-stripped");
            expect(entry.model).toBe("anthropic:claude-opus-4-6");
            expect(entry.callType).toBe("stream");
            expect(entry.original_count).toBe(2);
            expect(entry.fixed_count).toBe(1);
            expect(entry.removed).toEqual([{ index: 1, role: "assistant" }]);
            expect(entry.ts).toBeDefined();
        });

        test("does not write warn.log when no fixes needed", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ];

            await transformParams({
                params: makeParams(prompt),
                type: "stream",
                model: fakeModel,
            });

            const logPath = join(testBaseDir, "daemon", "warn.log");
            expect(existsSync(logPath)).toBe(false);
        });

        test("writes multiple log entries for multiple fixes", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [] },
                { role: "user", content: [{ type: "text", text: "Hello" }] },
                { role: "assistant", content: [{ type: "text", text: "Trailing" }] },
            ];

            await transformParams({
                params: makeParams(prompt),
                type: "generate",
                model: fakeModel,
            });

            const logPath = join(testBaseDir, "daemon", "warn.log");
            expect(existsSync(logPath)).toBe(true);

            const lines = readFileSync(logPath, "utf-8").trim().split("\n");
            expect(lines).toHaveLength(2);

            const entry1 = JSON.parse(lines[0]);
            expect(entry1.fix).toBe("empty-content-stripped");

            const entry2 = JSON.parse(lines[1]);
            expect(entry2.fix).toBe("trailing-assistant-stripped");
        });
    });

    describe("OTel span events", () => {
        test("adds span event when fixes are applied", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [{ type: "text", text: "Hello" }] },
                { role: "assistant", content: [{ type: "text", text: "Trailing" }] },
            ];

            await transformParams({
                params: makeParams(prompt),
                type: "stream",
                model: fakeModel,
            });

            const sanitizerEvents = spanEvents.filter(
                (e) => e.name === "message-sanitizer.fix-applied"
            );
            expect(sanitizerEvents).toHaveLength(1);

            const attrs = sanitizerEvents[0].attributes!;
            expect(attrs["sanitizer.fixes"]).toBe("trailing-assistant-stripped");
            expect(attrs["sanitizer.original_count"]).toBe(2);
            expect(attrs["sanitizer.fixed_count"]).toBe(1);
            expect(attrs["sanitizer.model"]).toBe("anthropic:claude-opus-4-6");
            expect(attrs["sanitizer.call_type"]).toBe("stream");
        });

        test("does not add span event when no fixes needed", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ];

            await transformParams({
                params: makeParams(prompt),
                type: "stream",
                model: fakeModel,
            });

            const sanitizerEvents = spanEvents.filter(
                (e) => e.name === "message-sanitizer.fix-applied"
            );
            expect(sanitizerEvents).toHaveLength(0);
        });

        test("includes all fixes in span event attributes", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "assistant", content: [] },
                { role: "user", content: [{ type: "text", text: "Hello" }] },
                { role: "assistant", content: [{ type: "text", text: "Trailing" }] },
            ];

            await transformParams({
                params: makeParams(prompt),
                type: "generate",
                model: fakeModel,
            });

            const sanitizerEvents = spanEvents.filter(
                (e) => e.name === "message-sanitizer.fix-applied"
            );
            expect(sanitizerEvents).toHaveLength(1);

            const attrs = sanitizerEvents[0].attributes!;
            expect(attrs["sanitizer.fixes"]).toBe("empty-content-stripped,trailing-assistant-stripped");
        });
    });

    describe("params passthrough", () => {
        test("returns params unchanged when no fixes needed", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "system", content: "System" },
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ];
            const params = makeParams(prompt);

            const result = await transformParams({
                params,
                type: "stream",
                model: fakeModel,
            });

            // Should be the exact same object reference
            expect(result).toBe(params);
        });

        test("preserves other params when prompt is modified", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [{ type: "text", text: "Hello" }] },
                { role: "assistant", content: [{ type: "text", text: "Trailing" }] },
            ];
            const params = {
                ...makeParams(prompt),
                temperature: 0.7,
                stopSequences: ["END"],
            };

            const result = await transformParams({
                params,
                type: "stream",
                model: fakeModel,
            });

            expect(result.temperature).toBe(0.7);
            expect(result.stopSequences).toEqual(["END"]);
            expect(result.prompt).toHaveLength(1);
        });
    });

    describe("combined sanitization", () => {
        test("handles empty content + trailing assistant in same pass", async () => {
            // After stripping empty content, the trailing assistant should also be caught
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [] },
                { role: "user", content: [{ type: "text", text: "Question" }] },
                { role: "assistant", content: [{ type: "text", text: "Answer" }] },
                { role: "assistant", content: [] },
            ];

            const result = await transformParams({
                params: makeParams(prompt),
                type: "stream",
                model: fakeModel,
            });

            // Empty user removed, empty assistant removed, then trailing "Answer" assistant removed
            expect(result.prompt).toHaveLength(1);
            expect(result.prompt[0].role).toBe("user");
        });
    });
});
