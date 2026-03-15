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
        expect(events.some((event) => event.eventName === "context_management.runtime_complete")).toBe(true);
        expect(
            events.some((event) =>
                event.eventName === "context_management.strategy_complete.context-utilization-reminder"
            )
        ).toBe(true);
        expect(
            events.some((event) =>
                event.eventName === "context_management.tool_execute_start.scratchpad"
            )
        ).toBe(true);
        expect(
            events.some((event) =>
                event.eventName === "context_management.tool_execute_complete.scratchpad"
            )
        ).toBe(true);

        const runtimeStartEvent = events.find(
            (event) => event.eventName === "context_management.runtime_start"
        );
        expect(runtimeStartEvent).toBeDefined();
        expect(String(runtimeStartEvent?.attributes?.["context_management.summary"])).toContain(
            "Running"
        );
        expect(runtimeStartEvent?.attributes?.["context_management.strategy_count"]).toBe(5);

        const warningEvent = events.find(
            (event) =>
                event.eventName ===
                    "context_management.strategy_complete.context-utilization-reminder" &&
                event.attributes?.["context_management.strategy_name"] === "context-utilization-reminder"
        );
        expect(warningEvent).toBeDefined();
        expect(
            String(warningEvent?.attributes?.["context_management.strategy_payloads_json"])
        ).toContain("warningThresholdTokens");
        // With DEFAULT_WORKING_TOKEN_BUDGET (40,000) the small test prompt (~172 tokens)
        // is well below the 70% warning threshold, so the strategy skips.
        expect(warningEvent?.attributes?.["context_management.outcome"]).toBe("skipped");
        expect(String(warningEvent?.attributes?.["context_management.summary"])).toContain(
            "Skipped scratchpad context warning"
        );

        const scratchpadEvent = events.find(
            (event) =>
                event.eventName === "context_management.strategy_complete.scratchpad" &&
                event.attributes?.["context_management.strategy_name"] === "scratchpad"
        );
        expect(scratchpadEvent).toBeDefined();
        expect(
            String(scratchpadEvent?.attributes?.["context_management.strategy_payloads_json"])
        ).toContain("forcedToolChoice");
        // With ~172 tokens against a 40,000-token budget, the prompt is well below
        // the force-scratchpad threshold, so forcedToolChoice is false.
        expect(scratchpadEvent?.attributes?.["context_management.forced_tool_choice"]).toBe(false);
        expect(String(scratchpadEvent?.attributes?.["context_management.summary"])).toContain(
            "Rendered scratchpad context"
        );
        expect(scratchpadEvent?.attributes?.["context_management.keep_last_messages"]).toBeUndefined();

        const statusEvent = events.find(
            (event) =>
                event.eventName === "context_management.strategy_complete.context-window-status" &&
                event.attributes?.["context_management.strategy_name"] === "context-window-status"
        );
        expect(statusEvent).toBeDefined();
        expect(
            String(statusEvent?.attributes?.["context_management.strategy_payloads_json"])
        ).toContain("estimatedPromptTokens");
        expect(
            String(statusEvent?.attributes?.["context_management.strategy_payloads_json"])
        ).toContain("workingBudgetUtilizationPercent");
        expect(String(statusEvent?.attributes?.["context_management.summary"])).toContain(
            "Inserted context status"
        );
        // ~172 tokens against 40,000-token working budget
        expect(
            typeof statusEvent?.attributes?.["context_management.working_budget_utilization_percent"]
        ).toBe("number");

        const decayEvent = events.find(
            (event) =>
                event.eventName === "context_management.strategy_complete.tool-result-decay"
        );
        expect(decayEvent).toBeDefined();
        expect(String(decayEvent?.attributes?.["context_management.summary"])).toContain(
            "tool-result decay"
        );
        const decayPayloads = String(decayEvent?.attributes?.["context_management.strategy_payloads_json"]);
        expect(decayPayloads).toContain("currentPromptTokens");

        const toolEvent = events.find(
            (event) => event.eventName === "context_management.tool_execute_complete.scratchpad"
        );
        expect(toolEvent).toBeDefined();
        expect(
            String(toolEvent?.attributes?.["context_management.tool_input_json"])
        ).toContain("Track the current parser state");
        // The omit tool call IDs appear in the input, not the result
        expect(
            String(toolEvent?.attributes?.["context_management.tool_input_json"])
        ).toContain("call-obsolete");
        expect(String(toolEvent?.attributes?.["context_management.summary"])).toContain(
            "Updated scratchpad"
        );
        expect(toolEvent?.attributes?.["context_management.notes_char_count"]).toBe(30);
        expect(toolEvent?.attributes?.["context_management.omit_tool_call_id_count"]).toBe(1);

        const runtimeCompleteEvent = events.find(
            (event) => event.eventName === "context_management.runtime_complete"
        );
        expect(runtimeCompleteEvent).toBeDefined();
        expect(String(runtimeCompleteEvent?.attributes?.["context_management.summary"])).toContain(
            "Completed context management"
        );
        expect(runtimeCompleteEvent?.attributes?.["context_management.tokens_saved"]).not.toBeUndefined();
    });
});
