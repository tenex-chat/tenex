import { createMessageSanitizerMiddleware as createSanitizer } from "ai-sdk-message-sanitizer";
import type { LanguageModelV3Message, LanguageModelV3Middleware } from "@ai-sdk/provider";
import { trace } from "@opentelemetry/api";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getTenexBasePath } from "@/constants";

function writeWarnLog(entry: Record<string, unknown>): void {
    try {
        const dir = join(getTenexBasePath(), "daemon");
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "warn.log"), JSON.stringify(entry) + "\n", "utf-8");
    } catch {
        // Best-effort logging — never let warn logging crash the LLM call
    }
}

function isDictionary(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeInputType(value: unknown): string {
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        return "array";
    }
    return typeof value;
}

function serializeInvalidInput(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (value === undefined) {
        return "";
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function wrapInvalidToolInput(value: unknown): Record<string, unknown> {
    if (value === undefined || value === null) {
        return {};
    }

    return {
        _tenex_invalid_tool_input: true,
        _tenex_original_input_type: describeInputType(value),
        raw_input: serializeInvalidInput(value),
    };
}

function sanitizeToolCallInputs(
    prompt: LanguageModelV3Message[],
    context: { callType: string; model: string }
): LanguageModelV3Message[] {
    let changed = false;

    const nextPrompt = prompt.map((message, messageIndex) => {
        if (message.role !== "assistant" || !Array.isArray(message.content)) {
            return message;
        }

        let messageChanged = false;
        const nextContent = message.content.map((part, partIndex) => {
            if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "tool-call") {
                return part;
            }

            const input = "input" in part ? part.input : undefined;
            if (isDictionary(input)) {
                return part;
            }

            changed = true;
            messageChanged = true;
            trace.getActiveSpan()?.addEvent("llm.tool_call_input_wrapped", {
                "message.index": messageIndex,
                "message.part_index": partIndex,
                "tool.name": "toolName" in part && typeof part.toolName === "string"
                    ? part.toolName
                    : "unknown",
                "tool.call_id": "toolCallId" in part && typeof part.toolCallId === "string"
                    ? part.toolCallId
                    : "unknown",
                "tool.input_type": describeInputType(input),
            });
            writeWarnLog({
                fix: "tool-call-input-wrapped",
                model: context.model,
                callType: context.callType,
                ts: Date.now(),
                messageIndex,
                partIndex,
                toolCallId: "toolCallId" in part && typeof part.toolCallId === "string"
                    ? part.toolCallId
                    : undefined,
                toolName: "toolName" in part && typeof part.toolName === "string"
                    ? part.toolName
                    : "unknown",
                inputType: describeInputType(input),
            });

            return {
                ...part,
                input: wrapInvalidToolInput(input),
            };
        });

        if (!messageChanged) {
            return message;
        }

        return {
            ...message,
            content: nextContent,
        };
    });

    return changed ? nextPrompt : prompt;
}

export function createMessageSanitizerMiddleware(): LanguageModelV3Middleware {
    const sanitizer = createSanitizer({
        onFix: writeWarnLog,
    });

    return {
        ...sanitizer,
        async transformParams(context) {
            const prompt = sanitizeToolCallInputs(context.params.prompt, {
                callType: context.type,
                model: `${context.model.provider}:${context.model.modelId}`,
            });

            const params = prompt === context.params.prompt
                ? context.params
                : {
                    ...context.params,
                    prompt,
                };

            if (!sanitizer.transformParams) {
                return params;
            }

            return sanitizer.transformParams({
                ...context,
                params,
            });
        },
    };
}
