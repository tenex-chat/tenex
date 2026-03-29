import { trace } from "@opentelemetry/api";
import type { TelemetrySettings } from "ai";
import { shortenConversationId } from "@/utils/conversation-id";

/**
 * Get trace correlation ID for OpenRouter.
 * Returns a string combining trace and span IDs for unique request identification.
 */
export function getTraceCorrelationId(): string | undefined {
    const span = trace.getActiveSpan();
    if (!span) return undefined;
    const ctx = span.spanContext();
    return `tenex-${ctx.traceId}-${ctx.spanId}`;
}

/**
 * @deprecated Use shortenConversationId from @/utils/conversation-id instead.
 * This function is kept for backward compatibility but will be removed in a future version.
 */
export function shortenConversationIdForSpan(conversationId: string): string {
    return shortenConversationId(conversationId);
}

/**
 * Get OpenRouter metadata for request correlation.
 * Includes OTL trace context plus agent and conversation identifiers.
 */
export function getOpenRouterMetadata(
    agentSlug?: string,
    conversationId?: string,
    projectId?: string,
    additionalMetadata?: Record<string, string | number | boolean>
): Record<string, string> {
    const metadata: Record<string, string> = {};

    const span = trace.getActiveSpan();
    if (span) {
        const ctx = span.spanContext();
        metadata.tenex_trace_id = ctx.traceId;
        metadata.tenex_span_id = ctx.spanId;
    }

    if (agentSlug) metadata.tenex_agent = agentSlug;
    if (conversationId) metadata.tenex_conversation = conversationId;
    if (projectId) metadata.tenex_project = projectId;
    for (const [key, value] of Object.entries(additionalMetadata ?? {})) {
        metadata[key.replace(/\./g, "_")] = String(value);
    }

    return metadata;
}

/**
 * Get full telemetry configuration for AI SDK.
 * Captures EVERYTHING for debugging - no privacy filters.
 */
export function getFullTelemetryConfig(config: {
    agentSlug?: string;
    agentId?: string;
    conversationId?: string;
    projectId?: string;
    provider: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
    contextWindow?: number;
    additionalMetadata?: Record<string, string | number | boolean>;
}): TelemetrySettings {
    if (!config.agentSlug) {
        throw new Error("[TracingUtils] Missing required agentSlug for telemetry.");
    }

    return {
        isEnabled: true,
        functionId: `${config.agentSlug}.${config.provider}.${config.model}`,

        // Metadata for debugging context
        metadata: {
            "agent.slug": config.agentSlug,
            ...(config.agentId ? { "agent.id": config.agentId } : {}),
            ...(config.conversationId ? { "conversation.id": config.conversationId } : {}),
            ...(config.projectId ? { "project.id": config.projectId } : {}),
            "llm.provider": config.provider,
            "llm.model": config.model,
            "llm.temperature": config.temperature ?? 0,
            "llm.max_tokens": config.maxTokens ?? 0,
            "llm.context_window": config.contextWindow ?? 0,
            ...(config.additionalMetadata ?? {}),
        },

        // FULL DATA - no privacy filters for debugging
        recordInputs: true, // Capture full prompts
        recordOutputs: true, // Capture full responses
    };
}
