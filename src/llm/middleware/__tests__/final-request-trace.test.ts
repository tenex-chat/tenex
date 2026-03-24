import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";

const addEvent = mock(() => {});
const setAttributes = mock(() => {});
const mockSpan = {
    addEvent,
    setAttributes,
};

mock.module("@opentelemetry/api", () => ({
    createContextKey: mock((name: string) => Symbol.for(name)),
    DiagLogLevel: {
        NONE: 0,
        ERROR: 1,
        WARN: 2,
        INFO: 3,
        DEBUG: 4,
        VERBOSE: 5,
        ALL: 6,
    },
    diag: {
        setLogger: mock(() => {}),
        debug: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
        info: mock(() => {}),
    },
    SpanKind: {
        INTERNAL: 0,
        SERVER: 1,
        CLIENT: 2,
        PRODUCER: 3,
        CONSUMER: 4,
    },
    trace: {
        getActiveSpan: () => mockSpan,
    },
    SpanStatusCode: { ERROR: 2, OK: 1 },
    TraceFlags: { NONE: 0, SAMPLED: 1 },
}));

import { createFinalRequestTraceMiddleware } from "../final-request-trace";

const fakeModel: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    supportedUrls: {},
    doGenerate: async () => {
        throw new Error("not implemented");
    },
    doStream: async () => {
        throw new Error("not implemented");
    },
};

describe("final-request trace middleware", () => {
    beforeEach(() => {
        addEvent.mockClear();
        setAttributes.mockClear();
    });

    test("captures post-middleware stream params on the active span", async () => {
        const middleware = createFinalRequestTraceMiddleware();
        const providerOptions: Record<string, unknown> = {
            openrouter: { usage: { include: true } },
        };
        providerOptions.self = providerOptions;

        const params = {
            prompt: [
                { role: "system", content: "System prompt" },
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ],
            providerOptions,
            toolChoice: { type: "auto" },
        };

        const result = await middleware.transformParams?.({
            params,
            type: "stream",
            model: fakeModel,
        });

        expect(result).toBe(params);
        expect(setAttributes).toHaveBeenCalledWith({
            "llm.request_type": "stream",
            "llm.final_message_count": 2,
            "llm.final_has_provider_options": true,
            "llm.final_has_tool_choice": true,
        });
        expect(addEvent).toHaveBeenCalledWith(
            "llm.final_request.captured",
            expect.objectContaining({
                "llm.final_prompt_json": expect.stringContaining("Hello"),
                "llm.final_provider_options_json": expect.stringContaining("[Circular]"),
                "llm.final_tool_choice_json": expect.stringContaining("\"auto\""),
            })
        );
    });

    test("skips non-stream requests", async () => {
        const middleware = createFinalRequestTraceMiddleware();
        const params = {
            prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        };

        const result = await middleware.transformParams?.({
            params,
            type: "generate",
            model: fakeModel,
        });

        expect(result).toBe(params);
        expect(addEvent).not.toHaveBeenCalled();
    });
});
