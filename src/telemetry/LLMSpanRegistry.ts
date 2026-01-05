/**
 * Registry to track LLM execution span IDs by trace ID.
 * Allows published events to reference the LLM span that generated their content.
 *
 * When an ai.streamText.doStream span ends, its span ID is stored here keyed by trace ID.
 * When publishing events, we look up the LLM span ID to link directly to the LLM execution.
 */
const llmSpansByTrace = new Map<string, string>();

export function setLLMSpanId(traceId: string, spanId: string): void {
    llmSpansByTrace.set(traceId, spanId);
}

export function getLLMSpanId(traceId: string): string | undefined {
    return llmSpansByTrace.get(traceId);
}

export function clearLLMSpanId(traceId: string): void {
    llmSpansByTrace.delete(traceId);
}
