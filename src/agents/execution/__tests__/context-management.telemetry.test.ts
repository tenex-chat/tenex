import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";

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
    type ExecutionContextManagement,
} from "../context-management";

describe("TENEX context management telemetry", () => {
    const TEST_DIR = "/tmp/tenex-context-management-telemetry";
    const PROJECT_ID = "project-context-management-telemetry";
    const CONVERSATION_ID = "conv-context-management-telemetry";
    const AGENT_PUBKEY = "agent-pubkey-telemetry";

    let store: ConversationStore;
    let getContextManagementConfigSpy: ReturnType<typeof spyOn>;
    let getSummarizationModelNameSpy: ReturnType<typeof spyOn>;

    function buildContextManagementConfig(overrides: Record<string, unknown>) {
        return {
            tokenBudget: 40000,
            forceScratchpadThresholdPercent: 70,
            utilizationWarningThresholdPercent: 70,
            ...overrides,
        };
    }

    async function prepareManagedRequest(
        contextManagement: ExecutionContextManagement | undefined,
        messages: Array<Record<string, unknown>>,
        model: { provider: string; modelId: string } = { provider: "mock", modelId: "mock" }
    ) {
        expect(contextManagement).toBeDefined();
        return await contextManagement?.prepareRequest({
            messages: messages as any,
            model,
        });
    }

    beforeEach(async () => {
        addEvent.mockClear();
        await mkdir(TEST_DIR, { recursive: true });
        store = new ConversationStore(TEST_DIR);
        store.load(PROJECT_ID, CONVERSATION_ID);
        getContextManagementConfigSpy = spyOn(
            configService,
            "getContextManagementConfig"
        ).mockReturnValue(buildContextManagementConfig({}) as any);
        getSummarizationModelNameSpy = spyOn(
            configService,
            "getSummarizationModelName"
        ).mockImplementation(() => {
            throw new Error("summarization model unavailable in tests");
        });
    });

    afterEach(async () => {
        getContextManagementConfigSpy?.mockRestore();
        getSummarizationModelNameSpy?.mockRestore();
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    test("maps package telemetry into OTel span events with derived attributes", async () => {
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

        const scratchpadTool = contextManagement?.optionalTools.scratchpad as {
            execute: (
                input: unknown,
                options: { toolCallId?: string; experimental_context: Record<string, unknown> }
            ) => Promise<unknown>;
        };

        await scratchpadTool.execute(
            {
                description: "Capture the current parser state in scratchpad",
                setEntries: {
                    notes: "Track the current parser state",
                },
                omitToolCallIds: ["call-obsolete"],
            },
            {
                toolCallId: "tool-call-1",
                experimental_context: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement?.requestContext,
                },
            }
        );

        await prepareManagedRequest(contextManagement, [
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
        ]);

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

        const strategyOrder = events
            .filter((event) => event.eventName.startsWith("context_management.strategy_complete."))
            .map((event) => String(event.attributes?.["context_management.strategy_name"]));
        expect(strategyOrder.indexOf("scratchpad")).toBeGreaterThanOrEqual(0);
        expect(strategyOrder.indexOf("tool-result-decay")).toBeGreaterThanOrEqual(0);
        expect(strategyOrder.indexOf("scratchpad")).toBeLessThan(
            strategyOrder.indexOf("tool-result-decay")
        );

        const warningEvent = events.find(
            (event) =>
                event.eventName ===
                    "context_management.strategy_complete.context-utilization-reminder" &&
                event.attributes?.["context_management.strategy_name"] === "context-utilization-reminder"
        );
        expect(warningEvent).toBeDefined();
        expect(warningEvent?.attributes?.["context_management.warning_threshold_tokens"]).toBe(
            28000
        );
        expect(warningEvent?.attributes?.["context_management.outcome"]).toBe("skipped");
        expect(warningEvent?.attributes?.["context_management.budget_scope"]).toBe(
            "managed-context"
        );
        expect(String(warningEvent?.attributes?.["context_management.summary"])).toContain(
            "Skipped scratchpad context warning"
        );

        const scratchpadEvent = events.find(
            (event) =>
                event.eventName === "context_management.strategy_complete.scratchpad" &&
                event.attributes?.["context_management.strategy_name"] === "scratchpad"
        );
        expect(scratchpadEvent).toBeDefined();
        expect(scratchpadEvent?.attributes?.["context_management.forced_tool_choice"]).toBe(false);
        expect(scratchpadEvent?.attributes?.["context_management.force_threshold_tokens"]).toBe(
            28000
        );
        expect(String(scratchpadEvent?.attributes?.["context_management.summary"])).toContain(
            "Rendered scratchpad context"
        );

        const statusEvent = events.find(
            (event) =>
                event.eventName === "context_management.strategy_complete.context-window-status" &&
                event.attributes?.["context_management.strategy_name"] === "context-window-status"
        );
        expect(statusEvent).toBeDefined();
        expect(statusEvent?.attributes?.["context_management.estimated_prompt_tokens"]).toBeDefined();
        expect(statusEvent?.attributes?.["context_management.managed_context_tokens"]).toBeDefined();
        expect(String(statusEvent?.attributes?.["context_management.summary"])).toContain(
            "Inserted context status"
        );
        expect(statusEvent?.attributes?.["context_management.budget_scope"]).toBe(
            "managed-context"
        );

        const decayEvent = events.find(
            (event) =>
                event.eventName === "context_management.strategy_complete.tool-result-decay"
        );
        expect(decayEvent).toBeDefined();
        expect(String(decayEvent?.attributes?.["context_management.summary"])).toContain(
            "tool-result decay"
        );

        const toolEvent = events.find(
            (event) => event.eventName === "context_management.tool_execute_complete.scratchpad"
        );
        expect(toolEvent).toBeDefined();
        expect(String(toolEvent?.attributes?.["context_management.summary"])).toContain(
            "Updated scratchpad"
        );
        expect(toolEvent?.attributes?.["context_management.entry_char_count"]).toBeGreaterThan(0);
        expect(toolEvent?.attributes?.["context_management.entry_update_count"]).toBe(1);
        expect(toolEvent?.attributes?.["context_management.omit_tool_call_id_count"]).toBe(1);

        const runtimeCompleteEvent = events.find(
            (event) => event.eventName === "context_management.runtime_complete"
        );
        expect(runtimeCompleteEvent).toBeDefined();
        expect(String(runtimeCompleteEvent?.attributes?.["context_management.summary"])).toContain(
            "Completed context management"
        );
        expect(runtimeCompleteEvent?.attributes?.["context_management.tokens_saved"]).not.toBeUndefined();
        expect(runtimeCompleteEvent?.attributes?.["context_management.estimated_tokens_before"]).toBeDefined();
        expect(runtimeCompleteEvent?.attributes?.["context_management.estimated_tokens_after"]).toBeDefined();
    });

    test("records forced scratchpad choice on the scratchpad strategy event", async () => {
        getContextManagementConfigSpy.mockReturnValue(
            buildContextManagementConfig({
                tokenBudget: 200,
            }) as any
        );

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

        await prepareManagedRequest(contextManagement, [
            { role: "system", content: "You are helpful." },
            {
                role: "user",
                content: [{ type: "text", text: `Long request ${"z".repeat(620)}` }],
            },
        ]);

        const scratchpadEvent = addEvent.mock.calls
            .map(([eventName, attributes]) => ({ eventName, attributes }))
            .find(
                (event) =>
                    event.eventName === "context_management.strategy_complete.scratchpad"
            );

        expect(scratchpadEvent).toBeDefined();
        expect(scratchpadEvent?.attributes?.["context_management.forced_tool_choice"]).toBe(true);
        expect(String(scratchpadEvent?.attributes?.["context_management.summary"])).toContain(
            "forced scratchpad tool choice"
        );
    });

    test("tool-result decay no longer uses a managed working budget gate", async () => {
        getContextManagementConfigSpy.mockReturnValue(
            buildContextManagementConfig({
                tokenBudget: 100,
                forceScratchpadThresholdPercent: 100,
                utilizationWarningThresholdPercent: 100,
                summarizationFallbackThresholdPercent: 100,
            }) as any
        );

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

        await prepareManagedRequest(contextManagement, [
            {
                role: "system",
                content: `You are helpful. ${"s".repeat(2400)}`,
            },
            {
                role: "user",
                content: [{ type: "text", text: "Short request." }],
            },
        ]);

        const events = addEvent.mock.calls.map(([eventName, attributes]) => ({
            eventName,
            attributes,
        }));
        const decayEvent = events.find(
            (event) =>
                event.eventName === "context_management.strategy_complete.tool-result-decay"
        );

        expect(decayEvent).toBeDefined();
        expect(decayEvent?.attributes?.["context_management.outcome"]).toBe("skipped");
        expect(decayEvent?.attributes?.["context_management.reason"]).toBe("no-tool-exchanges");
        expect(decayEvent?.attributes?.["context_management.current_prompt_tokens"]).toBeLessThan(
            20
        );
        expect(decayEvent?.attributes?.["context_management.working_token_budget"]).toBeUndefined();
    });

});
