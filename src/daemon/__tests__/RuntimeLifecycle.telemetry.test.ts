import { afterEach, describe, expect, it, mock } from "bun:test";

interface RecordedSpan {
    name: string;
    attributes: Record<string, unknown>;
    events: Array<{ name: string; attributes: Record<string, unknown> }>;
    status?: Record<string, unknown>;
    exceptions: unknown[];
    ended: boolean;
}

type SpanHandle = ReturnType<typeof createSpan>;
type TelemetryContext = { span?: SpanHandle } | undefined;

const spans: RecordedSpan[] = [];
let currentContext: TelemetryContext;
let contextWithCalls = 0;
let startupSawActiveSpan = false;

function createSpan(name: string, attributes: Record<string, unknown> = {}) {
    const span: RecordedSpan = {
        name,
        attributes: { ...attributes },
        events: [],
        exceptions: [],
        ended: false,
    };
    spans.push(span);

    return {
        addEvent: (eventName: string, eventAttributes: Record<string, unknown> = {}) => {
            span.events.push({ name: eventName, attributes: { ...eventAttributes } });
        },
        setAttributes: (nextAttributes: Record<string, unknown>) => {
            Object.assign(span.attributes, nextAttributes);
        },
        setAttribute: (key: string, value: unknown) => {
            span.attributes[key] = value;
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

mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    },
}));

mock.module("@opentelemetry/api", () => ({
    SpanStatusCode: {
        UNSET: 0,
        OK: 1,
        ERROR: 2,
    },
    context: {
        active: () => currentContext,
        with: async (ctx: TelemetryContext, fn: () => unknown) => {
            contextWithCalls += 1;
            const previousContext = currentContext;
            currentContext = ctx;
            try {
                return await fn();
            } finally {
                currentContext = previousContext;
            }
        },
    },
    trace: {
        getActiveSpan: () => currentContext?.span,
        getTracer: () => ({
            startActiveSpan: async (
                name: string,
                optionsOrFn: unknown,
                maybeFn?: (span: SpanHandle) => unknown
            ) => {
                const fn = typeof optionsOrFn === "function"
                    ? optionsOrFn as (span: SpanHandle) => unknown
                    : maybeFn!;
                const options = typeof optionsOrFn === "function"
                    ? {}
                    : optionsOrFn as { attributes?: Record<string, unknown> };
                const span = createSpan(name, options.attributes);
                const previousContext = currentContext;
                currentContext = { span };

                let result: unknown;
                try {
                    result = fn(span);
                } catch (error) {
                    currentContext = previousContext;
                    throw error;
                }

                // Deliberately drop async context unless a caller explicitly restores it
                // via context.with(). This mirrors the boot queue behavior under test.
                currentContext = previousContext;
                return await result;
            },
        }),
    },
}));

mock.module("../ProjectRuntime", () => ({
    ProjectRuntime: class {
        constructor(_project: unknown, _projectsBase: string) {}

        async start(): Promise<void> {
            await Promise.resolve();
            startupSawActiveSpan = Boolean(currentContext?.span);
            currentContext?.span?.addEvent("mock.project_runtime.start");
        }

        getStatus(): { isRunning: boolean } {
            return { isRunning: false };
        }

        async stop(): Promise<void> {}
    },
}));

describe("RuntimeLifecycle telemetry", () => {
    afterEach(() => {
        spans.length = 0;
        currentContext = undefined;
        contextWithCalls = 0;
        startupSawActiveSpan = false;
    });

    it("restores telemetry context inside the serialized boot queue", async () => {
        const { RuntimeLifecycle } = await import(`../RuntimeLifecycle.ts?telemetry-${Date.now()}`);
        const { trace } = await import("@opentelemetry/api");

        const lifecycle = new RuntimeLifecycle("/tmp/tenex-projects");
        const tracer = trace.getTracer("test");
        const project = {
            tagValue: (key: string) => {
                if (key === "title") return "DDD";
                if (key === "d") return "ddd-project";
                return undefined;
            },
        };

        await tracer.startActiveSpan("root", async (rootSpan: SpanHandle) => {
            await lifecycle.startRuntime("ddd-project" as never, project as never);
            rootSpan.end();
        });

        const startupSpan = spans.find((span) => span.name === "tenex.runtime.startup");

        expect(contextWithCalls).toBeGreaterThan(0);
        expect(startupSawActiveSpan).toBe(true);
        expect(startupSpan?.attributes["project.id"]).toBe("ddd-project");
        expect(Number(startupSpan?.attributes["runtime.boot_queue.wait_ms"])).toBeGreaterThanOrEqual(0);
        expect(spans.some((span) => span.events.some((event) => event.name === "mock.project_runtime.start"))).toBe(true);
        expect(startupSpan?.status).toEqual({ code: 1 });
        expect(startupSpan?.ended).toBe(true);
    });
});
