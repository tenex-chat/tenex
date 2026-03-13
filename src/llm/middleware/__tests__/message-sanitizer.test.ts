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

function getToolCallIdsFromMsg(msg: LanguageModelV3Message): string[] {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return [];
    return (msg.content as Array<{ type: string; toolCallId?: string }>)
        .filter((p) => p.type === "tool-call" && typeof p.toolCallId === "string")
        .map((p) => p.toolCallId!);
}

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

        test("preserves trailing assistant tool-call messages", async () => {
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
            ];

            const params = makeParams(prompt);
            const result = await transformParams({
                params,
                type: "stream",
                model: fakeModel,
            });

            expect(result).toBe(params);
            expect(result.prompt).toEqual(prompt);
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

        test("writes a diagnostic log entry when tool-call ordering is invalid", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [{ type: "text", text: "Start" }] },
                {
                    role: "assistant",
                    content: [{
                        type: "tool-call",
                        toolCallId: "call-a",
                        toolName: "search",
                        input: { query: "a" },
                    }],
                },
                {
                    role: "assistant",
                    content: [{
                        type: "tool-call",
                        toolCallId: "call-b",
                        toolName: "search",
                        input: { query: "b" },
                    }],
                },
                {
                    role: "tool",
                    content: [{
                        type: "tool-result",
                        toolCallId: "call-a",
                        toolName: "search",
                        output: { type: "text", value: "result-a" },
                    }],
                },
                {
                    role: "user",
                    content: [{ type: "text", text: "Continue" }],
                },
            ];

            await transformParams({
                params: makeParams(prompt),
                type: "stream",
                model: fakeModel,
            });

            const logPath = join(testBaseDir, "daemon", "warn.log");
            expect(existsSync(logPath)).toBe(true);

            const entries = readFileSync(logPath, "utf-8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));

            expect(entries.some((entry) => entry.fix === "invalid-tool-order-detected")).toBe(true);

            const diagnosticEntry = entries.find((entry) => entry.fix === "invalid-tool-order-detected")!;
            expect(diagnosticEntry.tool_call_ids).toEqual(["call-a", "call-b"]);
            expect(diagnosticEntry.resolved_tool_call_ids).toEqual(["call-a"]);
            expect(diagnosticEntry.missing_tool_call_ids).toEqual(["call-b"]);
            expect(diagnosticEntry.next_block_role).toBe("user");
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

        test("adds a diagnostic span event when tool-call ordering is invalid", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [{ type: "text", text: "Start" }] },
                {
                    role: "assistant",
                    content: [{
                        type: "tool-call",
                        toolCallId: "call-a",
                        toolName: "search",
                        input: { query: "a" },
                    }],
                },
                {
                    role: "assistant",
                    content: [{
                        type: "tool-call",
                        toolCallId: "call-b",
                        toolName: "search",
                        input: { query: "b" },
                    }],
                },
                {
                    role: "tool",
                    content: [{
                        type: "tool-result",
                        toolCallId: "call-a",
                        toolName: "search",
                        output: { type: "text", value: "result-a" },
                    }],
                },
                {
                    role: "user",
                    content: [{ type: "text", text: "Continue" }],
                },
            ];

            const params = makeParams(prompt);
            const result = await transformParams({
                params,
                type: "stream",
                model: fakeModel,
            });

            expect(result).toBe(params);

            const diagnosticEvents = spanEvents.filter(
                (e) => e.name === "message-sanitizer.invalid-tool-order-detected"
            );
            expect(diagnosticEvents).toHaveLength(1);

            const attrs = diagnosticEvents[0].attributes!;
            expect(attrs["sanitizer.issue_count"]).toBe(1);
            expect(attrs["sanitizer.issue_block_starts"]).toBe("1");
            expect(attrs["sanitizer.missing_tool_call_ids"]).toBe("call-b");
            expect(attrs["sanitizer.model"]).toBe("anthropic:claude-opus-4-6");
            expect(attrs["sanitizer.call_type"]).toBe("stream");
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

    describe("tool ordering repair", () => {
        test("relocates misplaced tool results to the correct position", async () => {
            // Reproduces the exact error pattern from production:
            // assistant:[call-J, call-L, call-H, call-12e]
            // tool:[result-J only]
            // assistant:[call-Q, call-G]        ← violates: L,H,12e not resolved
            // tool:[result-12e, result-H, result-L, result-G, result-Q]
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [{ type: "text", text: "Start" }] },
                {
                    role: "assistant",
                    content: [
                        { type: "tool-call", toolCallId: "call-J", toolName: "fs_read", input: {} },
                        { type: "tool-call", toolCallId: "call-L", toolName: "fs_read", input: {} },
                        { type: "tool-call", toolCallId: "call-H", toolName: "fs_read", input: {} },
                        { type: "tool-call", toolCallId: "call-12e", toolName: "fs_read", input: {} },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        { type: "tool-result", toolCallId: "call-J", toolName: "fs_read", output: { type: "text", value: "result-J" } },
                    ],
                },
                {
                    role: "assistant",
                    content: [
                        { type: "tool-call", toolCallId: "call-Q", toolName: "fs_read", input: {} },
                        { type: "tool-call", toolCallId: "call-G", toolName: "fs_glob", input: {} },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        { type: "tool-result", toolCallId: "call-12e", toolName: "fs_read", output: { type: "text", value: "result-12e" } },
                        { type: "tool-result", toolCallId: "call-H", toolName: "fs_read", output: { type: "text", value: "result-H" } },
                        { type: "tool-result", toolCallId: "call-L", toolName: "fs_read", output: { type: "text", value: "result-L" } },
                        { type: "tool-result", toolCallId: "call-G", toolName: "fs_glob", output: { type: "text", value: "result-G" } },
                        { type: "tool-result", toolCallId: "call-Q", toolName: "fs_read", output: { type: "text", value: "result-Q" } },
                    ],
                },
            ];

            const result = await transformParams({
                params: makeParams(prompt),
                type: "stream",
                model: fakeModel,
            });

            const resultPrompt = result.prompt as LanguageModelV3Message[];

            // After repair: assistant(J,L,H,12e) → tool(J,L,H,12e) → assistant(Q,G) → tool(Q,G)
            // Find the tool message after the first assistant block
            const firstAssistantIdx = resultPrompt.findIndex(
                (m) => m.role === "assistant" && getToolCallIdsFromMsg(m).includes("call-J")
            );
            expect(firstAssistantIdx).toBeGreaterThan(0);

            // The next message(s) should be tool messages containing ALL results for J,L,H,12e
            const toolResultsAfterFirst: string[] = [];
            for (let i = firstAssistantIdx + 1; i < resultPrompt.length; i++) {
                const msg = resultPrompt[i];
                if (msg.role === "tool") {
                    for (const part of msg.content as Array<{ type: string; toolCallId: string }>) {
                        if (part.type === "tool-result") toolResultsAfterFirst.push(part.toolCallId);
                    }
                } else {
                    break;
                }
            }

            expect(toolResultsAfterFirst.sort()).toEqual(["call-12e", "call-H", "call-J", "call-L"]);

            // Verify Q and G calls come after their batch's results
            const secondAssistantIdx = resultPrompt.findIndex(
                (m, idx) => idx > firstAssistantIdx && m.role === "assistant" && getToolCallIdsFromMsg(m).includes("call-Q")
            );
            expect(secondAssistantIdx).toBeGreaterThan(firstAssistantIdx);

            // Results for Q and G should follow
            const toolResultsAfterSecond: string[] = [];
            for (let i = secondAssistantIdx + 1; i < resultPrompt.length; i++) {
                const msg = resultPrompt[i];
                if (msg.role === "tool") {
                    for (const part of msg.content as Array<{ type: string; toolCallId: string }>) {
                        if (part.type === "tool-result") toolResultsAfterSecond.push(part.toolCallId);
                    }
                } else {
                    break;
                }
            }

            expect(toolResultsAfterSecond.sort()).toEqual(["call-G", "call-Q"]);
        });

        test("logs repair when tool results are relocated", async () => {
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [{ type: "text", text: "Start" }] },
                {
                    role: "assistant",
                    content: [
                        { type: "tool-call", toolCallId: "call-a", toolName: "search", input: {} },
                        { type: "tool-call", toolCallId: "call-b", toolName: "search", input: {} },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        { type: "tool-result", toolCallId: "call-a", toolName: "search", output: { type: "text", value: "a" } },
                    ],
                },
                {
                    role: "assistant",
                    content: [{ type: "tool-call", toolCallId: "call-c", toolName: "search", input: {} }],
                },
                {
                    role: "tool",
                    content: [
                        { type: "tool-result", toolCallId: "call-b", toolName: "search", output: { type: "text", value: "b" } },
                        { type: "tool-result", toolCallId: "call-c", toolName: "search", output: { type: "text", value: "c" } },
                    ],
                },
            ];

            await transformParams({
                params: makeParams(prompt),
                type: "stream",
                model: fakeModel,
            });

            const logPath = join(testBaseDir, "daemon", "warn.log");
            const entries = readFileSync(logPath, "utf-8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));

            const repairEntry = entries.find((e) => e.fix === "tool-ordering-repaired");
            expect(repairEntry).toBeDefined();
            expect(repairEntry.repaired_tool_call_ids).toContain("call-b");

            // OTel event should be present
            const repairEvents = spanEvents.filter(
                (e) => e.name === "message-sanitizer.tool-ordering-repaired"
            );
            expect(repairEvents).toHaveLength(1);
        });

        test("does nothing when missing results are not in the prompt at all", async () => {
            // call-b has no result anywhere — repair can't fix it
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [{ type: "text", text: "Start" }] },
                {
                    role: "assistant",
                    content: [
                        { type: "tool-call", toolCallId: "call-a", toolName: "search", input: {} },
                        { type: "tool-call", toolCallId: "call-b", toolName: "search", input: {} },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        { type: "tool-result", toolCallId: "call-a", toolName: "search", output: { type: "text", value: "a" } },
                    ],
                },
                { role: "user", content: [{ type: "text", text: "Continue" }] },
            ];

            const params = makeParams(prompt);
            const result = await transformParams({
                params,
                type: "stream",
                model: fakeModel,
            });

            // Prompt should be unchanged (repair found nothing to move)
            expect(result).toBe(params);

            // But diagnostic log should still be written
            const logPath = join(testBaseDir, "daemon", "warn.log");
            const entries = readFileSync(logPath, "utf-8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));

            expect(entries.some((e) => e.fix === "invalid-tool-order-detected")).toBe(true);
            expect(entries.some((e) => e.fix === "tool-ordering-repaired")).toBe(false);
        });

        test("removes empty tool messages after extracting parts", async () => {
            // After extracting call-b's result from the last message, that message
            // only has call-c's result left. The message should remain.
            const prompt: LanguageModelV3Message[] = [
                { role: "user", content: [{ type: "text", text: "Start" }] },
                {
                    role: "assistant",
                    content: [
                        { type: "tool-call", toolCallId: "call-a", toolName: "t", input: {} },
                        { type: "tool-call", toolCallId: "call-b", toolName: "t", input: {} },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        { type: "tool-result", toolCallId: "call-a", toolName: "t", output: { type: "text", value: "a" } },
                    ],
                },
                {
                    role: "assistant",
                    content: [{ type: "tool-call", toolCallId: "call-c", toolName: "t", input: {} }],
                },
                {
                    role: "tool",
                    content: [
                        { type: "tool-result", toolCallId: "call-b", toolName: "t", output: { type: "text", value: "b" } },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        { type: "tool-result", toolCallId: "call-c", toolName: "t", output: { type: "text", value: "c" } },
                    ],
                },
            ];

            const result = await transformParams({
                params: makeParams(prompt),
                type: "stream",
                model: fakeModel,
            });

            const resultPrompt = result.prompt as LanguageModelV3Message[];

            // The message that originally had only call-b's result should be removed
            // (it's now empty after extraction)
            const emptyToolMessages = resultPrompt.filter(
                (m) => m.role === "tool" && Array.isArray(m.content) && m.content.length === 0
            );
            expect(emptyToolMessages).toHaveLength(0);

            // call-c's result should still be present
            const allToolResults = resultPrompt
                .filter((m) => m.role === "tool")
                .flatMap((m) => (m.content as Array<{ type: string; toolCallId: string }>))
                .filter((p) => p.type === "tool-result")
                .map((p) => p.toolCallId);

            expect(allToolResults).toContain("call-a");
            expect(allToolResults).toContain("call-b");
            expect(allToolResults).toContain("call-c");
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
