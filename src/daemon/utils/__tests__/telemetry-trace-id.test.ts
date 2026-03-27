import { describe, test, expect } from "bun:test";
import { shortenConversationId } from "@/utils/conversation-id";

/**
 * Test trace ID generation for Jaeger URLs
 * This is a copy of the internal nostrIdToTraceId function logic
 */
function nostrIdToTraceId(nostrId: string): string {
    // Use shortened 18-char ID (consistent with span attributes)
    const shortId = shortenConversationId(nostrId);
    // Pad to 32 chars with zeros (OTEL requirement)
    return shortId.padEnd(32, "0");
}

describe("Jaeger Trace ID Generation", () => {
    test("should generate 18-char shortened trace IDs padded to 32 chars", () => {
        const fullConversationId = "83f83677f9c7211e1dcbcbf934e3884fab78dac59abfe0068c80db03715248dc";
        const traceId = nostrIdToTraceId(fullConversationId);

        // Should start with 18-char shortened ID
        expect(traceId.substring(0, 18)).toBe("83f83677f9c7211e1d");

        // Should be padded to 32 chars total
        expect(traceId.length).toBe(32);

        // Should end with zeros (padding)
        expect(traceId).toBe("83f83677f9c7211e1d00000000000000");
    });

    test("should handle different conversation IDs consistently", () => {
        const conversationId1 = "abcdef123456789012345678901234567890123456789012345678901234567890";
        const conversationId2 = "123456789abc000000000000000000000000000000000000000000000000000000";

        const traceId1 = nostrIdToTraceId(conversationId1);
        const traceId2 = nostrIdToTraceId(conversationId2);

        expect(traceId1).toBe("abcdef123456789012000000000000000".substring(0, 32));
        expect(traceId2).toBe("123456789abc000000000000000000000".substring(0, 32));

        // Both should be 32 chars
        expect(traceId1.length).toBe(32);
        expect(traceId2.length).toBe(32);
    });

    test("should create valid hex strings for OpenTelemetry", () => {
        const conversationId = "deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";
        const traceId = nostrIdToTraceId(conversationId);

        // Should be valid hex
        expect(/^[0-9a-f]{32}$/.test(traceId)).toBe(true);

        // Should start with shortened ID
        expect(traceId.substring(0, 18)).toBe("deadbeef1234567890");
    });

    test("Jaeger URL should use shortened trace ID", () => {
        const fullConversationId = "83f83677f9c7211e1dcbcbf934e3884fab78dac59abfe0068c80db03715248dc";
        const traceId = nostrIdToTraceId(fullConversationId);

        // Jaeger URL format: /trace/{traceId}
        const jaegerUrl = `/trace/${traceId}`;

        // URL should contain the shortened ID at the start
        expect(jaegerUrl).toContain("83f83677f9c7211e1d");

        // Should NOT contain the full 32-char prefix from the original ID
        expect(jaegerUrl).not.toContain("83f83677f9c7211e1dcbcbf934e3884f");

        // The recognizable part of the URL should be 18 chars (not 32)
        expect(jaegerUrl).toBe("/trace/83f83677f9c7211e1d00000000000000");
    });
});
