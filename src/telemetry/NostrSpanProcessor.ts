import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Convert a Nostr hex ID to OpenTelemetry spanID (16 hex chars)
 */
function nostrIdToSpanId(nostrId: string): string {
    return nostrId.substring(0, 16);
}

/**
 * SpanProcessor that rewrites span IDs for Nostr event processing spans.
 *
 * Problem: OpenTelemetry generates random spanIds, but we derive parentSpanId
 * from Nostr event IDs (e-tags). This causes parent-child relationships to break
 * because the random spanId doesn't match the derived parentSpanId.
 *
 * Solution: For spans with event.id attribute, rewrite their spanId to be
 * deterministically derived from the event ID. This ensures that when another
 * span references this event via e-tag, the parentSpanId will match.
 */
export class NostrSpanProcessor implements SpanProcessor {
    forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    shutdown(): Promise<void> {
        return Promise.resolve();
    }

    onStart(_span: Span, _parentContext: Context): void {
        // Nothing to do on start
    }

    onEnd(span: ReadableSpan): void {
        // Only process spans that have event.id attribute (Nostr event processing spans)
        const eventId = span.attributes["event.id"];
        if (typeof eventId !== "string" || !eventId) {
            return;
        }

        // Rewrite spanId to be derived from event.id
        const derivedSpanId = nostrIdToSpanId(eventId);

        // Access internal state - the Span class stores context in _spanContext
        // biome-ignore lint/suspicious/noExplicitAny: Need to access private OTEL internals
        const spanAny = span as any;

        // Modify the spanContext's spanId
        if (spanAny._spanContext) {
            spanAny._spanContext.spanId = derivedSpanId;
        }

        // Fix parentSpanId based on event.reply_to
        const replyTo = span.attributes["event.reply_to"];
        if (typeof replyTo === "string" && replyTo) {
            const derivedParentSpanId = nostrIdToSpanId(replyTo);

            // Modify the parent span context
            if (spanAny._parentSpanContext) {
                spanAny._parentSpanContext.spanId = derivedParentSpanId;
            } else if (spanAny.parentSpanContext) {
                // Some versions store it differently
                spanAny.parentSpanContext.spanId = derivedParentSpanId;
            }
        }
    }
}

/**
 * Transform a ReadableSpan to fix Nostr event IDs before export.
 * Returns a new object with modified spanId and parentSpanId.
 */
export function transformSpanForExport(span: ReadableSpan): ReadableSpan {
    const eventId = span.attributes["event.id"];
    if (typeof eventId !== "string" || !eventId) {
        return span; // Not a Nostr event span, return as-is
    }

    const derivedSpanId = nostrIdToSpanId(eventId);
    const originalContext = span.spanContext();

    // Determine parent span ID
    let parentSpanContext = span.parentSpanContext;
    const replyTo = span.attributes["event.reply_to"];
    if (typeof replyTo === "string" && replyTo && parentSpanContext) {
        const derivedParentSpanId = nostrIdToSpanId(replyTo);
        parentSpanContext = {
            ...parentSpanContext,
            spanId: derivedParentSpanId,
        };
    }

    // Return a proxy that overrides spanContext
    return {
        ...span,
        spanContext: () => ({
            ...originalContext,
            spanId: derivedSpanId,
        }),
        parentSpanContext,
    };
}
