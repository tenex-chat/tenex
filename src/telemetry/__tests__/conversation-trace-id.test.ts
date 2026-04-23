import { describe, expect, it } from "bun:test";
import { context as otelContext, trace, TraceFlags } from "@opentelemetry/api";
import {
    contextForConversation,
    traceIdFromConversationId,
} from "@/telemetry/conversation-trace-id";

describe("traceIdFromConversationId", () => {
    it("returns the first 32 chars of a 64-char hex conversation ID lowercased", () => {
        const conversationId = "ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        expect(traceIdFromConversationId(conversationId)).toBe(
            "abcdef0123456789abcdef0123456789"
        );
    });

    it("hashes non-hex conversation IDs (e.g. telegram) to 32 hex chars", () => {
        const traceId = traceIdFromConversationId("tg_599309204_123");
        expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    });

    it("is deterministic for the same conversation ID", () => {
        const id = "tg_42_7";
        expect(traceIdFromConversationId(id)).toBe(traceIdFromConversationId(id));
    });

    it("produces different trace IDs for different conversation IDs", () => {
        const a = traceIdFromConversationId("tg_42_7");
        const b = traceIdFromConversationId("tg_42_8");
        expect(a).not.toBe(b);
    });

    it("always emits 32 hex characters", () => {
        for (const input of ["short", "tg_1_2", "a".repeat(64), "😀-weird-id"]) {
            expect(traceIdFromConversationId(input)).toMatch(/^[0-9a-f]{32}$/);
        }
    });
});

describe("contextForConversation", () => {
    it("produces a context whose active span context carries the derived trace ID", () => {
        const conversationId = "a".repeat(64);
        const ctx = contextForConversation(conversationId);
        const spanContext = trace.getSpanContext(ctx);
        expect(spanContext?.traceId).toBe("a".repeat(32));
    });

    it("marks the span context as sampled so child spans are exported", () => {
        const ctx = contextForConversation("tg_1_1");
        const spanContext = trace.getSpanContext(ctx);
        expect(spanContext?.traceFlags).toBe(TraceFlags.SAMPLED);
    });

    it("emits a 16-hex-char synthetic parent span ID that is stable for a given conversation", () => {
        const id = "deadbeef".repeat(8);
        const a = trace.getSpanContext(contextForConversation(id))?.spanId;
        const b = trace.getSpanContext(contextForConversation(id))?.spanId;
        expect(a).toMatch(/^[0-9a-f]{16}$/);
        expect(a).toBe(b);
    });

    it("flags the context as remote so it is treated as continuation, not a local parent span", () => {
        const ctx = contextForConversation("tg_1_1");
        const spanContext = trace.getSpanContext(ctx);
        expect(spanContext?.isRemote).toBe(true);
    });

    it("extends the supplied base context rather than replacing it", () => {
        const baseKey = Symbol("base");
        const baseCtx = otelContext.active().setValue(baseKey, "present");
        const derived = contextForConversation("tg_1_1", baseCtx);
        expect(derived.getValue(baseKey)).toBe("present");
    });
});
