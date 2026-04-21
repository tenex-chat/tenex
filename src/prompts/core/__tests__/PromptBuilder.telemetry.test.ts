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
        setAttribute: (key: string, value: unknown) => {
            span.attributes[key] = value;
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

const noopContext = {
    getValue: (_key: symbol) => undefined,
    setValue: (_key: symbol, _value: unknown) => noopContext,
    deleteValue: (_key: symbol) => noopContext,
};

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
            startSpan: (name: string) => createSpan(name),
        }),
    },
    context: {
        active: () => noopContext,
        with: (_ctx: unknown, fn: () => unknown) => fn(),
        bind: <T>(target: T) => target,
    },
    ROOT_CONTEXT: noopContext,
}));

describe("PromptBuilder telemetry", () => {
    afterEach(() => {
        spans.length = 0;
        activeSpan = undefined;
    });

    it("builds fragments successfully without fragment spans", async () => {
        const { PromptBuilder } = await import(`../PromptBuilder.ts?telemetry-success-${Date.now()}`);
        const { fragmentRegistry } = await import("../FragmentRegistry");

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

        const result = await new PromptBuilder()
            .add("fast-fragment", {})
            .add("slow-fragment", {})
            .build();

        expect(result).toBe("fast\n\nslow");
        fragmentRegistry.clear();
    });

    it("throws error when a template throws", async () => {
        const { PromptBuilder } = await import(`../PromptBuilder.ts?telemetry-failure-${Date.now()}`);
        const { fragmentRegistry } = await import("../FragmentRegistry");

        fragmentRegistry.clear();
        fragmentRegistry.register({
            id: "broken-fragment",
            template: () => {
                throw new Error("fragment exploded");
            },
        });

        await expect(
            new PromptBuilder().add("broken-fragment", {}).build()
        ).rejects.toThrow('Error executing fragment "broken-fragment"');

        fragmentRegistry.clear();
    });
});
