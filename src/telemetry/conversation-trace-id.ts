import { createHash } from "node:crypto";
import {
    type Context,
    context as otelContext,
    trace,
    TraceFlags,
} from "@opentelemetry/api";
import { SHORT_EVENT_ID_LENGTH } from "@/types/event-ids";
import { shortenConversationId } from "@/utils/conversation-id";

const TRACE_ID_LENGTH = 32;
const ZERO_PADDING = "0".repeat(TRACE_ID_LENGTH - SHORT_EVENT_ID_LENGTH);

/**
 * Derive a deterministic 32-char hex OTEL trace ID from a conversation ID so that
 * every span emitted during a conversation lands in the same Jaeger trace.
 *
 * Format: `<shortenConversationId(id)><zeros to 32 chars>`. This lets humans recognise
 * the trace in /trace/<traceId> from the same 10-char prefix used in span attributes
 * and logs.
 */
export function traceIdFromConversationId(conversationId: string): string {
    return `${shortenConversationId(conversationId)}${ZERO_PADDING}`;
}

function parentSpanIdFromConversationId(conversationId: string): string {
    return createHash("sha256")
        .update(`tenex.conversation.parent:${conversationId}`)
        .digest("hex")
        .slice(0, 16);
}

/**
 * Build an OTEL context pinned to the conversation's derived trace ID.
 * Spans started under this context inherit the trace ID and a stable phantom
 * parent span ID, so every execution of the conversation lands under one
 * Jaeger trace (`/trace/<traceId>`).
 */
export function contextForConversation(
    conversationId: string,
    parent: Context = otelContext.active()
): Context {
    return trace.setSpanContext(parent, {
        traceId: traceIdFromConversationId(conversationId),
        spanId: parentSpanIdFromConversationId(conversationId),
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
    });
}
