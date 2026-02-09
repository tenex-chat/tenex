import { describe, test, expect } from "bun:test";
import { shortenConversationId } from "@/utils/conversation-id";

/**
 * Test trace ID generation for Jaeger URLs
 * This is a copy of the internal nostrIdToTraceId function logic
 */
function nostrIdToTraceId(nostrId: string): string {
    // Use shortened 12-char ID (consistent with span attributes)
    const shortId = shortenConversationId(nostrId);
    // Pad to 32 chars with zeros (OTEL requirement)
    return shortId.padEnd(32, "0");
}

describe("Jaeger Trace ID Generation", () => {
    test("should generate 12-char shortened trace IDs padded to 32 chars", () => {
        const fullConversationId = "83f83677f9c7211e1dcbcbf934e3884fab78dac59abfe0068c80db03715248dc";
        const traceId = nostrIdToTraceId(fullConversationId);

        // Should start with 12-char shortened ID
        expect(traceId.substring(0, 12)).toBe("83f83677f9c7");

        // Should be padded to 32 chars total
        expect(traceId.length).toBe(32);

        // Should end with zeros (padding)
        expect(traceId).toBe("83f83677f9c700000000000000000000");
    });

    test("should handle different conversation IDs consistently", () => {
        const conversationId1 = "abcdef123456789012345678901234567890123456789012345678901234567890";
        const conversationId2 = "123456789abc000000000000000000000000000000000000000000000000000000";

        const traceId1 = nostrIdToTraceId(conversationId1);
        const traceId2 = nostrIdToTraceId(conversationId2);

        expect(traceId1).toBe("abcdef12345600000000000000000000");
        expect(traceId2).toBe("123456789abc00000000000000000000");

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
        expect(traceId.substring(0, 12)).toBe("deadbeef1234");
    });

    test("Jaeger URL should use shortened trace ID", () => {
        const fullConversationId = "83f83677f9c7211e1dcbcbf934e3884fab78dac59abfe0068c80db03715248dc";
        const traceId = nostrIdToTraceId(fullConversationId);

        // Jaeger URL format: /trace/{traceId}
        // With old implementation: /trace/83f83677f9c7211e1dcbcbf934e3884f (first 32 chars)
        // With new implementation: /trace/83f83677f9c700000000000000000000 (first 12 chars + padding)

        const jaegerUrl = `/trace/${traceId}`;

        // URL should contain the shortened ID at the start
        expect(jaegerUrl).toContain("83f83677f9c7");

        // Should NOT contain the full 32-char prefix from the original ID
        expect(jaegerUrl).not.toContain("83f83677f9c7211e1dcbcbf934e3884f");

        // The recognizable part of the URL should be 12 chars (not 32)
        expect(jaegerUrl).toBe("/trace/83f83677f9c700000000000000000000");
    });
});
