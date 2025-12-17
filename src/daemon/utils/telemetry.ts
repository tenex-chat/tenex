import type { NDKEvent } from "@nostr-dev-kit/ndk";
import {
    ROOT_CONTEXT,
    SpanStatusCode,
    propagation,
    trace,
    TraceFlags,
    type Span,
    type SpanContext,
} from "@opentelemetry/api";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { TagExtractor } from "@/nostr/TagExtractor";
import { getConversationSpanManager } from "@/telemetry/ConversationSpanManager";

/**
 * Convert a Nostr hex ID to OpenTelemetry traceID (32 hex chars)
 * Nostr event IDs are 64 hex chars, OTEL traceID is 32 hex chars
 */
function nostrIdToTraceId(nostrId: string): string {
    return nostrId.substring(0, 32);
}

/**
 * Convert a Nostr hex ID to OpenTelemetry spanID (16 hex chars)
 */
function nostrIdToSpanId(nostrId: string): string {
    return nostrId.substring(0, 16);
}

/**
 * Create a trace context from Nostr event threading.
 *
 * This derives traceID from the conversation root (E tag) and parentSpanId
 * from the reply-to event (e tag), enabling proper trace hierarchies based
 * on Nostr's natural threading model.
 */
function createContextFromNostrEvent(event: NDKEvent): {
    context: typeof ROOT_CONTEXT;
    parentSpanId: string | undefined;
    traceId: string;
} {
    // 1. Determine conversationId (becomes traceID)
    const conversationId = AgentEventDecoder.getConversationRoot(event) || event.id;
    if (!conversationId) {
        return { context: ROOT_CONTEXT, parentSpanId: undefined, traceId: "" };
    }

    const traceId = nostrIdToTraceId(conversationId);

    // 2. Determine parent event ID from e-tag (the event this is replying to)
    const parentEventId = TagExtractor.getFirstETag(event);
    const parentSpanId = parentEventId ? nostrIdToSpanId(parentEventId) : undefined;

    // 3. Create span context - if we have a parent, use its spanId; otherwise this is root
    const spanContext: SpanContext = {
        traceId,
        // Use parent's span ID if this is a reply, otherwise use conversation root as the span
        spanId: parentSpanId || nostrIdToSpanId(conversationId),
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
    };

    // 4. Create context with this span context as parent
    const parentContext = trace.setSpanContext(ROOT_CONTEXT, spanContext);

    return { context: parentContext, parentSpanId, traceId };
}

/**
 * Create a telemetry span for event processing with conversation-aware trace context.
 *
 * This function derives OpenTelemetry trace/span IDs from Nostr event threading:
 * - traceID = first 32 chars of conversation root ID (all messages in a conversation share this)
 * - parentSpanId = first 16 chars of reply-to event ID (creates parent-child hierarchy)
 * - spanID = first 16 chars of this event's ID (unique per event)
 *
 * This enables viewing entire conversations as single traces in Jaeger with proper
 * hierarchical relationships based on Nostr's e-tag threading.
 */
export function createEventSpan(event: NDKEvent) {
    // First check for explicit trace_context tag (backwards compat with delegations)
    const traceContextTag = event.tags.find((t) => t[0] === "trace_context");

    let parentContext = ROOT_CONTEXT;
    let conversationId = AgentEventDecoder.getConversationRoot(event);
    let derivedTraceId: string | undefined;

    if (traceContextTag) {
        // Use explicit W3C trace context if provided (delegation events)
        const carrier = { traceparent: traceContextTag[1] };
        parentContext = propagation.extract(ROOT_CONTEXT, carrier);
    } else {
        // Derive trace context from Nostr event threading
        const derived = createContextFromNostrEvent(event);
        parentContext = derived.context;
        derivedTraceId = derived.traceId;
    }

    if (!conversationId && event.id) {
        conversationId = event.id;
    }

    // Get reply-to event for attribute logging
    const replyToEventId = TagExtractor.getFirstETag(event);

    // Create span with conversation-aware context
    const span = trace.getTracer("tenex.daemon").startSpan(
        "tenex.event.process",
        {
            attributes: {
                "event.id": event.id,
                "event.kind": event.kind || 0,
                "event.pubkey": event.pubkey,
                "event.created_at": event.created_at || 0,
                // Truncate content to avoid huge spans
                "event.content": event.content.substring(0, 500),
                "event.content_length": event.content.length,
                "event.tag_count": event.tags.length,
                "event.has_trace_context": !!traceContextTag,
                "event.reply_to": replyToEventId || "",
                "conversation.id": conversationId || "unknown",
                "conversation.is_root": !AgentEventDecoder.getConversationRoot(event),
                "trace.derived_from_nostr": !traceContextTag && !!derivedTraceId,
            },
        },
        parentContext
    );

    // Track message sequence
    if (conversationId) {
        getConversationSpanManager().incrementMessageCount(conversationId, span);
    }

    return span;
}

/**
 * End span with success status
 */
export function endSpanSuccess(span: Span) {
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
}

/**
 * End span with error status
 */
export function endSpanError(span: Span, error: unknown) {
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
    });
    span.end();
}

/**
 * Add routing decision event to span
 */
export function addRoutingEvent(
    span: Span,
    decision: string,
    details: Record<string, unknown>
) {
    span.addEvent("routing_decision", { decision, ...details });
}
