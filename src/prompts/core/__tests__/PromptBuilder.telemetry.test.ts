import { afterEach, describe, expect, it, mock } from "bun:test";

interface RecordedSpan {
    name: string;
    attributes: Record<string, unknown>;
    events: Array<{ name: string; attributes: Record<string, unknown> }>;
    status?: Record<string, unknown>;
    exceptions: unknown[];
    ended: boolean;
}

const spans: RecordedSpan[] = [];
let activeSpan: ReturnType<typeof createSpan> | undefined;

function createSpan(name: string) {
    const span: RecordedSpan = {
        name,
        attributes: {},
        events: [],
        exceptions: [],
        ended: false,
    };
    spans.push(span);

    return {
        addEvent: (eventName: string, eventAttributes: Record<string, unknown>) => {
            span.events.push({ name: eventName, attributes: { ...eventAttributes } });
        },
        setAttributes: (nextAttributes: Record<string, unknown>) => {
            Object.assign(span.attributes, nextAttributes);
        },
        setStatus: (status: Record<string, unknown>) => {
            span.status = status;
        },
        recordException: (error: unknown) => {
            span.exceptions.push(error);
        },
        end: () => {
            span.ended = true;
        },
        spanContext: () => ({
            traceId: "1".repeat(32),
            spanId: "2".repeat(16),
            traceFlags: 1,
        }),
    };
}

mock.module("@opentelemetry/api", () => ({
    SpanStatusCode: {
        UNSET: 0,
        OK: 1,
        ERROR: 2,
    },
    trace: {
        getActiveSpan: () => activeSpan,
        getTracer: () => ({
            startActiveSpan: async (
                name: string,
                optionsOrFn: unknown,
                maybeFn?: (span: ReturnType<typeof createSpan>) => unknown
            ) => {
                const fn = typeof optionsOrFn === "function"
                    ? optionsOrFn as (span: ReturnType<typeof createSpan>) => unknown
                    : maybeFn!;
                const span = createSpan(name);
                const previousSpan = activeSpan;
                activeSpan = span;
                try {
                    return await fn(span);
                } finally {
                    activeSpan = previousSpan;
                }
            },
        }),
    },
}));

describe("PromptBuilder telemetry", () => {
    afterEach(() => {
        spans.length = 0;
        activeSpan = undefined;
    });

    it("records fragment spans and a parent summary event", async () => {
        const { PromptBuilder } = await import(`../PromptBuilder.ts?telemetry-success-${Date.now()}`);
        const { fragmentRegistry } = await import("../FragmentRegistry");
        const { trace } = await import("@opentelemetry/api");

        fragmentRegistry.clear();
        fragmentRegistry.register({
            id: "fast-fragment",
            priority: 20,
            template: () => "fast",
        });
        fragmentRegistry.register({
            id: "slow-fragment",
            priority: 30,
            template: async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                return "slow";
            },
        });

        const tracer = trace.getTracer("test");
        const result = await tracer.startActiveSpan("tenex.message.compile", async () => {
            return await new PromptBuilder()
                .add("fast-fragment", {})
                .add("slow-fragment", {})
                .build();
        });

        expect(result).toBe("fast\n\nslow");

        const fastSpan = spans.find((span) => span.name === "tenex.prompt.fragment.fast-fragment");
        const slowSpan = spans.find((span) => span.name === "tenex.prompt.fragment.slow-fragment");
        const parentSpan = spans.find((span) => span.name === "tenex.message.compile");

        expect(fastSpan?.attributes["fragment.id"]).toBe("fast-fragment");
        expect(fastSpan?.attributes["fragment.priority"]).toBe(20);
        expect(fastSpan?.attributes["fragment.content.length"]).toBe(4);
        expect(fastSpan?.attributes["fragment.content.empty"]).toBe(false);
        expect(fastSpan?.ended).toBe(true);

        expect(slowSpan?.attributes["fragment.id"]).toBe("slow-fragment");
        expect(slowSpan?.attributes["fragment.priority"]).toBe(30);
        expect(slowSpan?.attributes["fragment.content.length"]).toBe(4);
        expect(Number(slowSpan?.attributes["fragment.duration_ms"])).toBeGreaterThanOrEqual(1);
        expect(slowSpan?.ended).toBe(true);

        const summaryEvent = parentSpan?.events.find((event) => event.name === "prompt.fragments_profiled");
        expect(summaryEvent?.attributes["fragment.count"]).toBe(2);
        expect(summaryEvent?.attributes["slowest.fragment.id"]).toBe("slow-fragment");
        expect(Number(summaryEvent?.attributes["slowest.duration_ms"])).toBeGreaterThanOrEqual(1);

        fragmentRegistry.clear();
    });

    it("marks fragment spans as failed when a template throws", async () => {
        const { PromptBuilder } = await import(`../PromptBuilder.ts?telemetry-failure-${Date.now()}`);
        const { fragmentRegistry } = await import("../FragmentRegistry");
        const { trace, SpanStatusCode } = await import("@opentelemetry/api");

        fragmentRegistry.clear();
        fragmentRegistry.register({
            id: "broken-fragment",
            template: () => {
                throw new Error("fragment exploded");
            },
        });

        const tracer = trace.getTracer("test");
        await expect(
            tracer.startActiveSpan("tenex.message.compile", async () => {
                return await new PromptBuilder().add("broken-fragment", {}).build();
            })
        ).rejects.toThrow('Error executing fragment "broken-fragment"');

        const brokenSpan = spans.find((span) => span.name === "tenex.prompt.fragment.broken-fragment");
        expect(brokenSpan?.attributes["fragment.id"]).toBe("broken-fragment");
        expect(brokenSpan?.attributes["error.message"]).toContain("fragment exploded");
        expect(brokenSpan?.status).toEqual({ code: SpanStatusCode.ERROR });
        expect(brokenSpan?.exceptions).toHaveLength(1);
        expect(brokenSpan?.ended).toBe(true);

        fragmentRegistry.clear();
    });
});
