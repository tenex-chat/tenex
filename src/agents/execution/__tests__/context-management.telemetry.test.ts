import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "fs/promises";

const addEvent = mock(() => {});
const mockSpan = {
    addEvent,
    setAttribute: mock(() => {}),
    setStatus: mock(() => {}),
    end: mock(() => {}),
    isRecording: () => true,
    recordException: mock(() => {}),
    updateName: mock(() => {}),
    setAttributes: mock(() => {}),
    spanContext: () => ({ traceId: "trace-id", spanId: "span-id", traceFlags: 1 }),
};
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
            startSpan: () => mockSpan,
            startActiveSpan: (_name: string, fn: (span: typeof mockSpan) => unknown) =>
                fn(mockSpan),
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

import type { AgentInstance } from "@/agents/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import { config as configService } from "@/services/ConfigService";
import {
    CONTEXT_MANAGEMENT_KEY,
    createExecutionContextManagement,
} from "../context-management";

describe("TENEX context management telemetry", () => {
    const TEST_DIR = "/tmp/tenex-context-management-telemetry";
    const PROJECT_ID = "project-context-management-telemetry";
    const CONVERSATION_ID = "conv-context-management-telemetry";
    const AGENT_PUBKEY = "agent-pubkey-telemetry";

    let store: ConversationStore;
    let originalLoadedConfig: unknown;

    beforeEach(async () => {
        addEvent.mockClear();
        await mkdir(TEST_DIR, { recursive: true });
        store = new ConversationStore(TEST_DIR);
        store.load(PROJECT_ID, CONVERSATION_ID);
        originalLoadedConfig = (configService as unknown as { loadedConfig?: unknown }).loadedConfig;
        (configService as unknown as { loadedConfig?: unknown }).loadedConfig = {
            config: {
                contextManagement: {
                    enabled: true,
                    tokenBudget: 200,
                    scratchpadEnabled: true,
                    forceScratchpadEnabled: true,
                    forceScratchpadThresholdPercent: 70,
                    utilizationWarningEnabled: true,
                    utilizationWarningThresholdPercent: 70,
                    summarizationFallbackEnabled: false,
                },
            },
            llms: { configurations: {}, default: undefined },
            mcp: { servers: {}, enabled: true },
            providers: { providers: {} },
        };
    });

    afterEach(async () => {
        (configService as unknown as { loadedConfig?: unknown }).loadedConfig = originalLoadedConfig;
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    test("maps package telemetry into OTel span events with serialized payloads", async () => {
        const agent = {
            name: "executor",
            slug: "executor",
            pubkey: AGENT_PUBKEY,
        } as AgentInstance;
        const contextManagement = createExecutionContextManagement({
            providerId: "openrouter",
            conversationId: CONVERSATION_ID,
            agent,
            conversationStore: store,
        });

        expect(contextManagement).toBeDefined();

        const scratchpadTool = contextManagement!.optionalTools.scratchpad as {
            execute: (
                input: unknown,
                options: { toolCallId?: string; experimental_context: Record<string, unknown> }
            ) => Promise<unknown>;
        };

        await scratchpadTool.execute(
            {
                notes: "Track the current parser state",
                omitToolCallIds: ["call-obsolete"],
            },
            {
                toolCallId: "tool-call-1",
                experimental_context: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement!.requestContext,
                },
            }
        );

        await contextManagement!.middleware.transformParams?.({
            params: {
                prompt: [
                    { role: "system", content: "You are helpful." },
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: `Long request ${"z".repeat(620)}`,
                            },
                        ],
                    },
                ],
                providerOptions: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement!.requestContext,
                },
            },
            model: {
                specificationVersion: "v3",
                provider: "mock",
                modelId: "mock",
                supportedUrls: {},
                doGenerate: async () => {
                    throw new Error("unused");
                },
                doStream: async () => {
                    throw new Error("unused");
                },
            },
        } as any);

        const events = addEvent.mock.calls.map(([eventName, attributes]) => ({
            eventName,
            attributes,
        }));

        expect(events.some((event) => event.eventName === "context_management.runtime_start")).toBe(true);
        expect(events.some((event) => event.eventName === "context_management.strategy_complete")).toBe(true);
        expect(events.some((event) => event.eventName === "context_management.runtime_complete")).toBe(true);
        expect(events.some((event) => event.eventName === "context_management.tool_execute_start")).toBe(true);
        expect(events.some((event) => event.eventName === "context_management.tool_execute_complete")).toBe(true);

        const warningEvent = events.find(
            (event) =>
                event.eventName === "context_management.strategy_complete" &&
                event.attributes?.["context_management.strategy_name"] ===
                    "context-utilization-reminder"
        );
        expect(warningEvent).toBeDefined();
        expect(
            String(warningEvent?.attributes?.["context_management.prompt_before_json"])
        ).toContain("Long request");
        expect(
            String(warningEvent?.attributes?.["context_management.strategy_payloads_json"])
        ).toContain("warningThresholdTokens");
        expect(
            String(warningEvent?.attributes?.["context_management.strategy_payloads_json"])
        ).toContain("reminderText");

        const scratchpadEvent = events.find(
            (event) =>
                event.eventName === "context_management.strategy_complete" &&
                event.attributes?.["context_management.strategy_name"] === "scratchpad"
        );
        expect(scratchpadEvent).toBeDefined();
        expect(
            String(scratchpadEvent?.attributes?.["context_management.strategy_payloads_json"])
        ).toContain("forcedToolChoice");

        const toolEvent = events.find(
            (event) => event.eventName === "context_management.tool_execute_complete"
        );
        expect(toolEvent).toBeDefined();
        expect(
            String(toolEvent?.attributes?.["context_management.tool_input_json"])
        ).toContain("Track the current parser state");
        expect(
            String(toolEvent?.attributes?.["context_management.tool_result_json"])
        ).toContain("call-obsolete");
    });
});
