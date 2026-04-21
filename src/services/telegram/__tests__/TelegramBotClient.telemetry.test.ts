import { afterEach, describe, expect, it, mock } from "bun:test";

interface RecordedSpan {
    name: string;
    attributes: Record<string, unknown>;
    events: Array<{ name: string; attributes: Record<string, unknown> }>;
    status?: Record<string, unknown>;
    ended: boolean;
}

const spans: RecordedSpan[] = [];
let activeSpan: {
    spanContext: () => { traceId: string; spanId: string; traceFlags: number };
} | undefined;

function createSpan(name: string, attributes: Record<string, unknown> = {}) {
    const span: RecordedSpan = {
        name,
        attributes: { ...attributes },
        events: [],
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
        recordException: () => {},
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
        warning: () => {},
        error: () => {},
        debug: () => {},
        success: () => {},
        isLevelEnabled: () => false,
        initDaemonLogging: async () => undefined,
        writeToWarnLog: () => undefined,
    },
}));

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
                const options = typeof optionsOrFn === "function"
                    ? {}
                    : optionsOrFn as { attributes?: Record<string, unknown> };
                const span = createSpan(name, options.attributes);
                const previousSpan = activeSpan;
                activeSpan = span;
                try {
                    return await fn(span);
                } finally {
                    activeSpan = previousSpan;
                }
            },
            startSpan: (name: string, options?: { attributes?: Record<string, unknown> }) =>
                createSpan(name, options?.attributes),
        }),
    },
    context: {
        active: () => noopContext,
        with: async (_context: unknown, fn: () => unknown) => await fn(),
        bind: <T>(target: T) => target,
    },
    ROOT_CONTEXT: noopContext,
}));

describe("TelegramBotClient telemetry", () => {
    afterEach(() => {
        spans.length = 0;
        activeSpan = undefined;
    });

    it("records getUpdates request and response payloads without exposing the full bot token", async () => {
        const { TelegramBotClient } = await import(`../TelegramBotClient.ts?telemetry-get-updates-${Date.now()}`);
        const fetchImpl = mock(async () =>
            new Response(
                JSON.stringify({
                    ok: true,
                    result: [
                        {
                            update_id: 99,
                            message: {
                                message_id: 5,
                                date: 123,
                                chat: { id: 1001, type: "private" },
                                from: {
                                    id: 42,
                                    is_bot: false,
                                    first_name: "Alice",
                                },
                                text: "hello",
                            },
                        },
                    ],
                }),
                { status: 200 }
            )
        );
        const client = new TelegramBotClient({
            botToken: "bot-secret-123456",
            apiBaseUrl: "https://telegram.example",
            fetchImpl,
        });

        await client.getUpdates({
            offset: 10,
            timeoutSeconds: 5,
            limit: 25,
        });

        const span = spans[0];
        expect(span?.name).toBe("tenex.telegram.api.getUpdates");
        expect(span?.attributes["telegram.bot.token_suffix"]).toBe("123456");
        expect(JSON.stringify(span?.attributes ?? {})).not.toContain("bot-secret-123456");
        expect(span?.attributes["telegram.update.count"]).toBe(1);
        expect(span?.events[0]?.name).toBe("telegram.api.request");
        expect(String(span?.events[0]?.attributes["telegram.api.request.query"])).toContain("\"offset\":10");
        expect(span?.events[1]?.name).toBe("telegram.api.response");
        expect(String(span?.events[1]?.attributes["telegram.api.response.body"])).toContain("\"update_id\":99");
        expect(span?.ended).toBe(true);
    });

    it("records sendMessage response metadata on the span", async () => {
        const { TelegramBotClient } = await import(`../TelegramBotClient.ts?telemetry-send-message-${Date.now()}`);
        const fetchImpl = mock(async () =>
            new Response(
                JSON.stringify({
                    ok: true,
                    result: {
                        message_id: 55,
                        date: 123,
                        chat: { id: -1001, type: "supergroup" },
                        message_thread_id: 9,
                    },
                }),
                { status: 200 }
            )
        );
        const client = new TelegramBotClient({
            botToken: "bot-secret-654321",
            apiBaseUrl: "https://telegram.example",
            fetchImpl,
        });

        await client.sendMessage({
            chatId: "-1001",
            text: "hello",
            replyToMessageId: "7",
            messageThreadId: "9",
        });

        const span = spans[0];
        expect(span?.name).toBe("tenex.telegram.api.sendMessage");
        expect(span?.attributes["telegram.sent_message.id"]).toBe("55");
        expect(span?.attributes["telegram.chat.id"]).toBe("-1001");
        expect(span?.attributes["telegram.chat.thread_id"]).toBe("9");
        expect(String(span?.events[0]?.attributes["telegram.api.request.body"])).toContain("\"reply_to_message_id\":7");
        expect(span?.ended).toBe(true);
    });
});
