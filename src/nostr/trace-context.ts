import { propagation, context as otelContext, trace } from "@opentelemetry/api";
import { getLLMSpanId } from "../telemetry/LLMSpanRegistry.js";

/**
 * Event-like object that has a tags array.
 * Compatible with NDKEvent and plain objects.
 */
export interface EventWithTags {
    tags: string[][];
}

/**
 * Inject W3C trace context into an event's tags.
 * This allows the daemon to link incoming events back to their parent span.
 * Also adds trace_context_llm which links to the LLM execution span for better debugging.
 *
 * @param event - Any object with a tags array (NDKEvent or plain object)
 */
export function injectTraceContext(event: EventWithTags): void {
    const carrier: Record<string, string> = {};
    propagation.inject(otelContext.active(), carrier);
    if (carrier.traceparent) {
        event.tags.push(["trace_context", carrier.traceparent]);
    }

    // Add trace context that links to LLM execution span (more useful for debugging)
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
        const spanContext = activeSpan.spanContext();
        const traceId = spanContext.traceId;

        // Use LLM span ID if available (links to actual LLM execution)
        // Otherwise fall back to current span ID
        const llmSpanId = getLLMSpanId(traceId);
        const spanIdToUse = llmSpanId || spanContext.spanId;

        event.tags.push(["trace_context_llm", `00-${traceId}-${spanIdToUse}-01`]);
    }
}
