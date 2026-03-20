import { describe, expect, it } from "bun:test";
import { NostrSpanProcessor } from "@/telemetry/NostrSpanProcessor";

describe("NostrSpanProcessor", () => {
    it("preserves trace-context parent spans when reply anchors are non-hex", () => {
        const processor = new NostrSpanProcessor();
        const span = {
            name: "tenex.event.process",
            attributes: {
                "event.id": "a".repeat(64),
                "event.reply_to": "tg_1001_5",
                "event.has_trace_context": true,
            },
            _spanContext: { spanId: "random-span-id" },
            _parentSpanContext: { spanId: "parent-from-trace-context" },
            spanContext: () => ({
                traceId: "1".repeat(32),
                spanId: "random-span-id",
                traceFlags: 1,
            }),
        };

        processor.onEnd(span as any);

        expect(span._spanContext.spanId).toBe("aaaaaaaaaaaaaaaa");
        expect(span._parentSpanContext?.spanId).toBe("parent-from-trace-context");
    });

    it("clears parent context instead of deriving invalid span IDs from non-hex replies", () => {
        const processor = new NostrSpanProcessor();
        const span = {
            name: "tenex.event.process",
            attributes: {
                "event.id": "b".repeat(64),
                "event.reply_to": "telegram:tg_1001_5",
                "event.has_trace_context": false,
            },
            _spanContext: { spanId: "random-span-id" },
            _parentSpanContext: { spanId: "should-be-cleared" },
            parentSpanContext: { spanId: "should-be-cleared" },
            spanContext: () => ({
                traceId: "1".repeat(32),
                spanId: "random-span-id",
                traceFlags: 1,
            }),
        };

        processor.onEnd(span as any);

        expect(span._spanContext.spanId).toBe("bbbbbbbbbbbbbbbb");
        expect(span._parentSpanContext).toBeUndefined();
        expect(span.parentSpanContext).toBeUndefined();
    });
});
