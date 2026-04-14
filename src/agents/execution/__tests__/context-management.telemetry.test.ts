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
            utilizationWarningThresholdPercent: 70,
            compactionThresholdPercent: 90,
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
            messages: messages as never,
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
        ).mockReturnValue(buildContextManagementConfig({}) as never);
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

        const compactContextTool = contextManagement?.optionalTools.compact_context as {
            execute: (
                input: unknown,
                options: {
                    toolCallId?: string;
                    messages?: Array<Record<string, unknown>>;
                    experimental_context: Record<string, unknown>;
                }
            ) => Promise<unknown>;
        };

        await compactContextTool.execute(
            {
                guidance: "Keep the parser findings concise.",
            },
            {
                toolCallId: "tool-call-1",
                messages: [
                    { role: "system", content: "You are helpful.", id: "system-1" },
                    {
                        role: "user",
                        id: "msg-user-1",
                        eventId: "evt-user-1",
                        content: [{ type: "text", text: "Inspect the parser flow." }],
                    },
                    {
                        role: "assistant",
                        id: "msg-assistant-1",
                        eventId: "evt-assistant-1",
                        content: [{ type: "text", text: "I traced the middleware ordering." }],
                    },
                ],
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
                event.eventName === "context_management.strategy_complete.reminders"
            )
        ).toBe(true);
        expect(
            events.some((event) =>
                event.eventName === "context_management.tool_execute_start.compact_context"
            )
        ).toBe(true);
        expect(
            events.some((event) =>
                event.eventName === "context_management.tool_execute_complete.compact_context"
            )
        ).toBe(true);
        expect(events.some((event) => event.eventName.includes("scratchpad"))).toBe(false);

        const runtimeStartEvent = events.find(
            (event) => event.eventName === "context_management.runtime_start"
        );
        expect(runtimeStartEvent).toBeDefined();
        expect(String(runtimeStartEvent?.attributes?.["context_management.summary"])).toContain(
            "Running"
        );
        expect(runtimeStartEvent?.attributes?.["context_management.strategy_count"]).toBe(4);

        const strategyOrder = events
            .filter((event) => event.eventName.startsWith("context_management.strategy_complete."))
            .map((event) => String(event.attributes?.["context_management.strategy_name"]));
        expect(strategyOrder).toEqual([
            "compaction-tool",
            "tool-result-decay",
            "reminders",
            "anthropic-prompt-caching",
        ]);

        const remindersEvent = events.find(
            (event) =>
                event.eventName ===
                    "context_management.strategy_complete.reminders" &&
                event.attributes?.["context_management.strategy_name"] === "reminders"
        );
        expect(remindersEvent).toBeDefined();
        expect(remindersEvent?.attributes?.["context_management.outcome"]).toBe("skipped");
        expect(remindersEvent?.attributes?.["context_management.reminder_count"]).toBe(0);
        expect(String(remindersEvent?.attributes?.["context_management.summary"])).toContain(
            "Evaluated reminders"
        );

        const anthropicCachingEvent = events.find(
            (event) =>
                event.eventName === "context_management.strategy_complete.anthropic-prompt-caching" &&
                event.attributes?.["context_management.strategy_name"] === "anthropic-prompt-caching"
        );
        expect(anthropicCachingEvent).toBeDefined();
        expect(anthropicCachingEvent?.attributes?.["context_management.outcome"]).toBe("skipped");
        expect(anthropicCachingEvent?.attributes?.["context_management.reason"]).toBe(
            "non-anthropic-provider"
        );

        const decayEvent = events.find(
            (event) =>
                event.eventName === "context_management.strategy_complete.tool-result-decay"
        );
        expect(decayEvent).toBeDefined();
        expect(String(decayEvent?.attributes?.["context_management.summary"])).toContain(
            "tool-result decay"
        );

        const compactionEvent = events.find(
            (event) =>
                event.eventName === "context_management.strategy_complete.compaction-tool"
        );
        expect(compactionEvent).toBeDefined();
        expect(compactionEvent?.attributes?.["context_management.outcome"]).toBe("skipped");
        expect(compactionEvent?.attributes?.["context_management.reason"]).toBe(
            "no-compaction-requested"
        );
        expect(String(compactionEvent?.attributes?.["context_management.summary"])).toContain(
            "Evaluated compaction"
        );

        const toolEvent = events.find(
            (event) => event.eventName === "context_management.tool_execute_complete.compact_context"
        );
        expect(toolEvent).toBeDefined();
        expect(String(toolEvent?.attributes?.["context_management.summary"])).toContain(
            "Rejected context compaction request"
        );

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

    test("does not emit scratchpad strategy events or forced tool choice under pressure", async () => {
        getContextManagementConfigSpy.mockReturnValue(
            buildContextManagementConfig({
                tokenBudget: 200,
            }) as never
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

        const prepared = await prepareManagedRequest(contextManagement, [
            { role: "system", content: "You are helpful." },
            {
                role: "user",
                content: [{ type: "text", text: `Long request ${"z".repeat(620)}` }],
            },
        ]);

        expect(prepared?.toolChoice).toBeUndefined();
        expect(JSON.stringify(prepared?.messages)).not.toContain("scratchpad");

        const events = addEvent.mock.calls.map(([eventName]) => String(eventName));
        expect(events.some((eventName) => eventName.includes("scratchpad"))).toBe(false);
    });

    test("tool-result decay no longer uses a managed working budget gate", async () => {
        getContextManagementConfigSpy.mockReturnValue(
            buildContextManagementConfig({
                tokenBudget: 100,
                utilizationWarningThresholdPercent: 100,
                compactionThresholdPercent: 100,
            }) as never
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
