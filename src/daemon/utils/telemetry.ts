import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { ROOT_CONTEXT, SpanStatusCode, propagation, trace } from "@opentelemetry/api";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { getConversationSpanManager } from "@/telemetry/ConversationSpanManager";

const tracer = trace.getTracer("tenex.daemon");

/**
 * Create a telemetry span for event processing with all standard attributes
 */
export function createEventSpan(event: NDKEvent) {
    // Extract trace context if present
    const traceContextTag = event.tags.find((t) => t[0] === "trace_context");
    let parentContext = ROOT_CONTEXT;
    if (traceContextTag) {
        const carrier = { traceparent: traceContextTag[1] };
        parentContext = propagation.extract(ROOT_CONTEXT, carrier);
    }

    // Determine conversation ID
    let conversationId = AgentEventDecoder.getConversationRoot(event);
    if (!conversationId && event.id) {
        conversationId = event.id;
    }

    // Create span with standard attributes
    const span = tracer.startSpan(
        "tenex.event.process",
        {
            attributes: {
                "event.id": event.id,
                "event.kind": event.kind || 0,
                "event.pubkey": event.pubkey,
                "event.created_at": event.created_at || 0,
                "event.content": event.content,
                "event.content_length": event.content.length,
                "event.tags": JSON.stringify(event.tags),
                "event.tag_count": event.tags.length,
                "event.has_trace_context": !!traceContextTag,
                "conversation.id": conversationId || "unknown",
                "conversation.is_root": !AgentEventDecoder.getConversationRoot(event),
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
export function endSpanSuccess(span: ReturnType<typeof tracer.startSpan>) {
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
}

/**
 * End span with error status
 */
export function endSpanError(span: ReturnType<typeof tracer.startSpan>, error: unknown) {
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
    span: ReturnType<typeof tracer.startSpan>,
    decision: string,
    details: Record<string, any>
) {
    span.addEvent("routing_decision", { decision, ...details });
}