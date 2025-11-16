import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Span } from "@opentelemetry/sdk-trace-base";

/**
 * Span processor that enriches tool call span names with the actual tool name.
 * Transforms generic "ai.toolCall" spans into "ai.toolCall.{toolName}" for better visibility.
 */
export class ToolCallSpanProcessor implements SpanProcessor {
    onStart(_span: Span, _parentContext: Context): void {
        // This is called when a span starts, but we can't modify the name here
        // because the attributes might not be set yet
    }

    onEnd(span: ReadableSpan): void {
        // Extract agent context if available
        const agentName = span.attributes?.["agent.name"];
        const agentSlug = span.attributes?.["agent.slug"];
        const agentPrefix = agentSlug || agentName;

        // Check if this is a tool call span
        if (span.name === "ai.toolCall" && span.attributes) {
            const toolName = span.attributes["ai.toolCall.name"];

            if (toolName && typeof toolName === "string") {
                // Include agent slug in the span name for better visibility
                const prefix = agentPrefix ? `[${agentPrefix}] ` : "";
                (span as any).name = `${prefix}ai.toolCall.${toolName}`;
            }
        }

        // Also enhance other AI operation spans with more context if available
        if (span.name === "ai.streamText" || span.name === "ai.generateText") {
            const model = span.attributes?.["ai.model.id"];
            if (model && typeof model === "string") {
                const shortModel = model.split("/").pop() || model;
                const prefix = agentPrefix ? `[${agentPrefix}] ` : "";
                (span as any).name = `${prefix}${span.name}.${shortModel}`;
            }
        }

        // Enhance agent execution spans
        if (span.name === "tenex.agent.execute" && agentPrefix) {
            const phase = span.attributes?.["conversation.phase"];
            const phaseStr = phase ? `.${phase}` : "";
            (span as any).name = `[${agentPrefix}] agent.execute${phaseStr}`;
        }
    }

    shutdown(): Promise<void> {
        return Promise.resolve();
    }

    forceFlush(): Promise<void> {
        return Promise.resolve();
    }
}
