import { trace } from "@opentelemetry/api";
import type { LanguageModelV3Middleware } from "@ai-sdk/provider";

function serializeTelemetryValue(value: unknown): string {
    const seen = new WeakSet<object>();

    try {
        return JSON.stringify(value, (_key, current) => {
            if (current instanceof Error) {
                return {
                    name: current.name,
                    message: current.message,
                    stack: current.stack,
                };
            }

            if (typeof current === "bigint") {
                return current.toString();
            }

            if (typeof current === "object" && current !== null) {
                if (seen.has(current)) {
                    return "[Circular]";
                }
                seen.add(current);
            }

            return current;
        }) ?? "null";
    } catch (error) {
        const fallbackError = error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : { message: String(error) };

        return JSON.stringify({
            serializationError: fallbackError,
            fallback: String(value),
        });
    }
}

function getPromptMessageCount(prompt: unknown): number {
    return Array.isArray(prompt) ? prompt.length : 0;
}

export function createFinalRequestTraceMiddleware(): LanguageModelV3Middleware {
    return {
        specificationVersion: "v3" as const,

        async transformParams({ params, type }) {
            if (type !== "stream") {
                return params;
            }

            const activeSpan = trace.getActiveSpan();

            activeSpan?.setAttributes({
                "llm.request_type": type,
                "llm.final_message_count": getPromptMessageCount(params.prompt),
                "llm.final_has_provider_options": params.providerOptions !== undefined,
                "llm.final_has_tool_choice": params.toolChoice !== undefined,
            });

            activeSpan?.addEvent("llm.final_request.captured", {
                "llm.final_prompt_json": serializeTelemetryValue(params.prompt),
                "llm.final_provider_options_json": serializeTelemetryValue(
                    params.providerOptions
                ),
                "llm.final_tool_choice_json": serializeTelemetryValue(params.toolChoice),
            });

            return params;
        },
    };
}
