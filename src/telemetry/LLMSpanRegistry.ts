/**
 * Registry to track LLM execution span IDs and API key identities by trace ID.
 * Allows published events to reference the LLM span that generated their content,
 * and provides API key identity information for trace attribution.
 *
 * When an ai.streamText.doStream span ends, its span ID is stored here keyed by trace ID.
 * When publishing events, we look up the LLM span ID to link directly to the LLM execution.
 */
const llmSpansByTrace = new Map<string, string>();
const apiKeyIdentitiesByTrace = new Map<string, string>();

export function setLLMSpanId(traceId: string, spanId: string): void {
    llmSpansByTrace.set(traceId, spanId);
}

export function getLLMSpanId(traceId: string): string | undefined {
    return llmSpansByTrace.get(traceId);
}

export function clearLLMSpanId(traceId: string): void {
    llmSpansByTrace.delete(traceId);
}

export function setApiKeyIdentity(traceId: string, identity: string): void {
    apiKeyIdentitiesByTrace.set(traceId, identity);
}

export function getApiKeyIdentity(traceId: string): string | undefined {
    return apiKeyIdentitiesByTrace.get(traceId);
}

export function clearApiKeyIdentity(traceId: string): void {
    apiKeyIdentitiesByTrace.delete(traceId);
}
