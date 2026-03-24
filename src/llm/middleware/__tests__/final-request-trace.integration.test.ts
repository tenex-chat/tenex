import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LanguageModelV3, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";

const addEvent = mock(() => {});
const end = mock(() => {});
const setAttributes = mock(() => {});
const mockSpan = {
    addEvent,
    end,
    setAttributes,
    setAttribute: mock(() => {}),
    setStatus: mock(() => {}),
    isRecording: () => true,
    recordException: mock(() => {}),
    updateName: mock(() => {}),
    spanContext: () => ({ traceId: "trace-id", spanId: "span-id", traceFlags: 1 }),
};
const startSpan = mock(() => mockSpan);
const mockContext = {
    getValue: () => undefined,
    setValue: () => mockContext,
    deleteValue: () => mockContext,
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
    ROOT_CONTEXT: mockContext,
    trace: {
        getActiveSpan: () => mockSpan,
        getTracer: () => ({
            startSpan,
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

import * as constantsModule from "@/constants";
import type { AgentInstance } from "@/agents/types";
import {
    CONTEXT_MANAGEMENT_KEY,
    createExecutionContextManagement,
} from "@/agents/execution/context-management";
import { resetSystemReminders } from "@/agents/execution/system-reminders";
import { ConversationStore } from "@/conversations/ConversationStore";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { config as configService } from "@/services/ConfigService";
import { createFinalRequestTraceMiddleware } from "../final-request-trace";
import { createMessageSanitizerMiddleware } from "../message-sanitizer";
import { createTenexSystemRemindersMiddleware } from "../system-reminders";

function buildContextManagementConfig(overrides: Record<string, unknown>) {
    return {
        enabled: true,
        tokenBudget: 40000,
        scratchpadEnabled: true,
        forceScratchpadEnabled: true,
        forceScratchpadThresholdPercent: 70,
        utilizationWarningEnabled: true,
        utilizationWarningThresholdPercent: 70,
        summarizationFallbackEnabled: false,
        ...overrides,
    };
}

function findEventAttributes(eventName: string): Record<string, unknown> | undefined {
    const match = addEvent.mock.calls.find(([name]) => name === eventName);
    return match?.[1] as Record<string, unknown> | undefined;
}

describe("final-request trace integration", () => {
    const agent = {
        name: "executor",
        slug: "executor",
        pubkey: "agent-pubkey-final-request",
    } as AgentInstance;

    let tempBaseDir: string;
    let storeDir: string;
    let store: ConversationStore;
    let getContextManagementConfigSpy: ReturnType<typeof spyOn>;
    let getTenexBasePathSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        tempBaseDir = join(tmpdir(), `tenex-final-request-${Date.now()}`);
        storeDir = join(tempBaseDir, "store");
        mkdirSync(storeDir, { recursive: true });
        store = new ConversationStore(storeDir);
        store.load("project-final-request", "conversation-final-request");

        addEvent.mockClear();
        end.mockClear();
        setAttributes.mockClear();
        startSpan.mockClear();
        resetSystemReminders();

        getContextManagementConfigSpy = spyOn(
            configService,
            "getContextManagementConfig"
        ).mockReturnValue(buildContextManagementConfig({}) as any);
        getTenexBasePathSpy = spyOn(constantsModule, "getTenexBasePath").mockReturnValue(
            tempBaseDir
        );
    });

    afterEach(() => {
        getContextManagementConfigSpy?.mockRestore();
        getTenexBasePathSpy?.mockRestore();
        resetSystemReminders();
        rmSync(tempBaseDir, { recursive: true, force: true });
    });

    test("captures reminder-injected prompt after context-management telemetry has already completed", async () => {
        const contextManagement = createExecutionContextManagement({
            providerId: "openrouter",
            conversationId: "conversation-final-request",
            agent,
            conversationStore: store,
        });

        const prompt: LanguageModelV3Prompt = [
            { role: "system", content: "System prompt" },
            {
                role: "user",
                content: [{ type: "text", text: "Hello from the user" }],
            },
        ];

        getSystemReminderContext().queue({
            type: "heuristic",
            content: "Remember the queued heuristic.",
        });

        const capturedDoStream = mock(async (params: Record<string, unknown>) => ({
            stream: new ReadableStream(),
            request: { body: params },
        }));

        const providerModel: LanguageModelV3 = {
            specificationVersion: "v3",
            provider: "test-provider",
            modelId: "test-model",
            supportedUrls: {},
            doGenerate: async () => {
                throw new Error("unused");
            },
            doStream: capturedDoStream as unknown as LanguageModelV3["doStream"],
        };

        const baseModel = wrapLanguageModel({
            model: providerModel,
            middleware: [
                createMessageSanitizerMiddleware(),
                createTenexSystemRemindersMiddleware(),
                createFinalRequestTraceMiddleware(),
            ],
        });
        const requestWrappedModel = wrapLanguageModel({
            model: baseModel,
            middleware: [contextManagement!.middleware as any],
        });

        await requestWrappedModel.doStream({
            prompt,
            providerOptions: {
                [CONTEXT_MANAGEMENT_KEY]: contextManagement!.requestContext,
            },
        } as any);

        const runtimeCompleteEvent = findEventAttributes("context_management.runtime_complete");
        const finalRequestEvent = findEventAttributes("llm.final_request.captured");
        const capturedPrompt = capturedDoStream.mock.calls[0]?.[0]?.prompt;

        expect(runtimeCompleteEvent).toBeDefined();
        expect(finalRequestEvent).toBeDefined();
        expect(String(runtimeCompleteEvent?.["context_management.final_prompt_json"])).toContain(
            "Hello from the user"
        );
        expect(String(runtimeCompleteEvent?.["context_management.final_prompt_json"])).not.toContain(
            "<heuristic>"
        );
        expect(String(finalRequestEvent?.["llm.final_prompt_json"])).toContain(
            "Hello from the user"
        );
        expect(String(finalRequestEvent?.["llm.final_prompt_json"])).toContain(
            "<heuristic>"
        );
        expect(String(finalRequestEvent?.["llm.final_prompt_json"])).toContain(
            "Remember the queued heuristic."
        );
        expect(JSON.parse(String(finalRequestEvent?.["llm.final_prompt_json"]))).toEqual(
            capturedPrompt
        );
    });

    test("captures the sanitized prompt that actually reaches the provider", async () => {
        const capturedDoStream = mock(async (params: Record<string, unknown>) => ({
            stream: new ReadableStream(),
            request: { body: params },
        }));

        const providerModel: LanguageModelV3 = {
            specificationVersion: "v3",
            provider: "test-provider",
            modelId: "test-model",
            supportedUrls: {},
            doGenerate: async () => {
                throw new Error("unused");
            },
            doStream: capturedDoStream as unknown as LanguageModelV3["doStream"],
        };

        const wrappedModel = wrapLanguageModel({
            model: providerModel,
            middleware: [
                createMessageSanitizerMiddleware(),
                createFinalRequestTraceMiddleware(),
            ],
        });

        await wrappedModel.doStream({
            prompt: [
                { role: "user", content: [] },
                {
                    role: "user",
                    content: [{ type: "text", text: "Keep this message" }],
                },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Remove trailing assistant" }],
                },
            ],
        } as any);

        const finalRequestEvent = findEventAttributes("llm.final_request.captured");
        const capturedPrompt = capturedDoStream.mock.calls[0]?.[0]?.prompt;
        const finalPrompt = JSON.parse(String(finalRequestEvent?.["llm.final_prompt_json"]));

        expect(finalRequestEvent).toBeDefined();
        expect(finalPrompt).toEqual(capturedPrompt);
        expect(finalPrompt).toEqual([
            {
                role: "user",
                content: [{ type: "text", text: "Keep this message" }],
            },
        ]);
    });
});
