import { describe, expect, it } from "bun:test";
import { context as otelContext, trace, TraceFlags } from "@opentelemetry/api";
import {
    contextForConversation,
    traceIdFromConversationId,
} from "@/telemetry/conversation-trace-id";
import { shortenConversationId } from "@/utils/conversation-id";

describe("traceIdFromConversationId", () => {
    it("uses the 10-char shortened conversation ID padded with zeros to 32 chars", () => {
        const conversationId = "747A01F1D4ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";
        expect(traceIdFromConversationId(conversationId)).toBe(
            "747a01f1d40000000000000000000000"
        );
    });

    it("matches shortenConversationId + zero padding for the short prefix", () => {
        const conversationId = "747A01F1D4ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";
        const traceId = traceIdFromConversationId(conversationId);
        expect(traceId.slice(0, 10)).toBe(shortenConversationId(conversationId));
        expect(traceId.slice(10)).toBe("0".repeat(22));
    });

    it("hashes non-hex conversation IDs (telegram) via shortenConversationId and pads with zeros", () => {
        const conversationId = "tg_599309204_123";
        const traceId = traceIdFromConversationId(conversationId);
        expect(traceId.slice(0, 10)).toBe(shortenConversationId(conversationId));
        expect(traceId.slice(10)).toBe("0".repeat(22));
    });

    it("is deterministic for the same conversation ID", () => {
        const id = "tg_42_7";
        expect(traceIdFromConversationId(id)).toBe(traceIdFromConversationId(id));
    });

    it("emits 32 hex characters for realistic conversation IDs (Nostr hex + telegram)", () => {
        for (const input of ["tg_1_2", "a".repeat(64), "DEADBEEF".repeat(8)]) {
            expect(traceIdFromConversationId(input)).toMatch(/^[0-9a-f]{32}$/);
        }
    });
});

describe("contextForConversation", () => {
    it("produces a context whose active span context carries the derived trace ID", () => {
        const conversationId = "a".repeat(64);
        const ctx = contextForConversation(conversationId);
        const spanContext = trace.getSpanContext(ctx);
        expect(spanContext?.traceId).toBe(`aaaaaaaaaa${"0".repeat(22)}`);
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
