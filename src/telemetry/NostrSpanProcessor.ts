import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Internal OTEL Span structure - accessing private fields to rewrite span IDs
 * This is necessary because OTEL doesn't expose a way to set spanId after creation
 */
interface SpanInternals {
    _spanContext?: { spanId: string };
    _parentSpanId?: string;
    _parentSpanContext?: { spanId: string };
    parentSpanContext?: { spanId: string };
}

/**
 * Convert a Nostr hex ID to OpenTelemetry spanID (16 hex chars)
 */
function nostrIdToSpanId(nostrId: string): string {
    return nostrId.substring(0, 16);
}

function isHexNostrId(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
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
        // Only rewrite spanIDs for tenex.event.process spans
        // Other spans (tenex.dispatch.chat_message, tenex.delegation.completion_check) share
        // event.id attribute but should NOT have their spanIDs rewritten to avoid collisions
        if (span.name !== "tenex.event.process") {
            return;
        }

        // Only process spans that have event.id attribute (Nostr event processing spans)
        const eventId = span.attributes["event.id"];
        if (!isHexNostrId(eventId)) {
            return;
        }

        // Rewrite spanId to be derived from event.id
        const derivedSpanId = nostrIdToSpanId(eventId);

        // Access internal state - the Span class stores context in _spanContext
        const spanInternal = span as unknown as SpanInternals;

        // Modify the spanContext's spanId
        if (spanInternal._spanContext) {
            spanInternal._spanContext.spanId = derivedSpanId;
        }

        // Fix parentSpanId based on event.reply_to
        const isDelegated = span.attributes["event.is_delegated_root"] === true;
        const replyTo = span.attributes["event.reply_to"];

        const hasTraceContext = span.attributes["event.has_trace_context"] === true;

        if (isHexNostrId(replyTo)) {
            // Reply to a Nostr event — set parent to the replied-to event
            const derivedParentSpanId = nostrIdToSpanId(replyTo);

            if (spanInternal._parentSpanContext) {
                spanInternal._parentSpanContext.spanId = derivedParentSpanId;
            } else if (spanInternal.parentSpanContext) {
                spanInternal.parentSpanContext.spanId = derivedParentSpanId;
            }
        } else if (isDelegated) {
            // Delegated root — trace_context was injected by the delegator but this span
            // starts a new trace in its own conversation. Clear parent so it is a true root
            // and won't be self-parented (spanId === parentSpanId).
            spanInternal._parentSpanContext = undefined;
            spanInternal.parentSpanContext = undefined;
        } else if (hasTraceContext) {
            // In-thread event with W3C trace context (e.g. reply via non-Nostr threading).
            // Preserve the extracted parent context as-is — but guard against self-parenting.
            // If the preserved parentSpanId equals this span's own derived spanId (which
            // happens when createContextFromNostrEvent used event.id as both trace root and
            // parent for a root event), clear the parent so this becomes a true root span.
            const preservedParentSpanId =
                spanInternal._parentSpanContext?.spanId ?? spanInternal.parentSpanContext?.spanId;
            if (preservedParentSpanId === derivedSpanId) {
                spanInternal._parentSpanContext = undefined;
                spanInternal.parentSpanContext = undefined;
            }
        } else {
            // Root message with no trace context — clear parent so it becomes a true root span.
            spanInternal._parentSpanContext = undefined;
            spanInternal.parentSpanContext = undefined;
        }
    }
}
