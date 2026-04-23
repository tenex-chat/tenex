import { createHash } from "node:crypto";
import {
    type Context,
    context as otelContext,
    trace,
    TraceFlags,
} from "@opentelemetry/api";

const HEX_32_OR_MORE = /^[0-9a-f]{32,}$/;

function sha256Hex(input: string): string {
    return createHash("sha256").update(input).digest("hex");
}

/**
 * Derive a deterministic 32-char hex OTEL trace ID from a conversation ID so that
 * every span emitted during a conversation lands in the same Jaeger trace.
 *
 * Hex-shaped conversation IDs (Nostr event IDs) map to their first 32 chars;
 * anything else (e.g. `tg_*`) is hashed so it still yields a valid trace ID.
 */
export function traceIdFromConversationId(conversationId: string): string {
    const normalized = conversationId.toLowerCase();
    if (HEX_32_OR_MORE.test(normalized)) {
        return normalized.slice(0, 32);
    }
    return sha256Hex(conversationId).slice(0, 32);
}

function parentSpanIdFromConversationId(conversationId: string): string {
    return sha256Hex(`tenex.conversation.parent:${conversationId}`).slice(0, 16);
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
