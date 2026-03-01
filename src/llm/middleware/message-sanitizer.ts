import type { LanguageModelMiddleware } from "ai";
import type {
    LanguageModelV3CallOptions,
    LanguageModelV3Message,
} from "@ai-sdk/provider";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getTenexBasePath } from "@/constants";
import { trace } from "@opentelemetry/api";

interface SanitizationWarning {
    fix: string;
    removed: Array<{ index: number; role: string }>;
}

/**
 * Check if a user or assistant message has empty content (content: []).
 * System messages use string content (always valid).
 * Tool messages may legitimately have minimal content for adjacency.
 */
function hasEmptyContent(msg: LanguageModelV3Message): boolean {
    if (msg.role === "system" || msg.role === "tool") return false;
    return Array.isArray(msg.content) && msg.content.length === 0;
}

/**
 * Run all sanitization passes on the original prompt, collecting warnings
 * with indices in the original coordinate space.
 *
 * Pass 1: Mark empty-content user/assistant messages for removal.
 * Pass 2: Mark trailing assistant messages for removal (from the end,
 *          skipping already-marked indices).
 *
 * Returns the filtered array and any warnings.
 */
function sanitize(
    prompt: LanguageModelV3Message[]
): { result: LanguageModelV3Message[]; warnings: SanitizationWarning[] } {
    const warnings: SanitizationWarning[] = [];
    const removeSet = new Set<number>();

    // Pass 1: empty content
    const emptyRemoved: Array<{ index: number; role: string }> = [];
    for (let i = 0; i < prompt.length; i++) {
        if (hasEmptyContent(prompt[i])) {
            emptyRemoved.push({ index: i, role: prompt[i].role });
            removeSet.add(i);
        }
    }
    if (emptyRemoved.length > 0) {
        warnings.push({ fix: "empty-content-stripped", removed: emptyRemoved });
    }

    // Pass 2: trailing assistants (walk backwards, skipping already-removed)
    const trailingRemoved: Array<{ index: number; role: string }> = [];
    for (let i = prompt.length - 1; i >= 0; i--) {
        if (removeSet.has(i)) continue;
        if (prompt[i].role !== "assistant") break;
        trailingRemoved.push({ index: i, role: "assistant" });
        removeSet.add(i);
    }
    if (trailingRemoved.length > 0) {
        warnings.push({ fix: "trailing-assistant-stripped", removed: trailingRemoved });
    }

    // Build filtered result
    const result = prompt.filter((_, i) => !removeSet.has(i));
    return { result, warnings };
}

/**
 * Append a structured warning to $TENEX_BASE_DIR/daemon/warn.log.
 * Uses appendFileSync — this path is rare (only on detected problems)
 * so the sync I/O cost is acceptable vs. the complexity of async.
 */
function logWarning(entry: Record<string, unknown>): void {
    try {
        const dir = join(getTenexBasePath(), "daemon");
        mkdirSync(dir, { recursive: true });
        const logPath = join(dir, "warn.log");
        appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
        // Best-effort logging — never let warn logging crash the LLM call
    }
}

/**
 * Creates a message sanitizer middleware that runs before every LLM API call.
 *
 * This middleware fixes message array problems that would cause API rejection:
 * - Trailing assistant messages (Anthropic rejects these)
 * - Empty-content user/assistant messages
 *
 * It intercepts `params.prompt` via `transformParams`, covering all call paths:
 * initial streamText, prepareStep-rebuilt messages, generateText, and generateObject.
 *
 * When fixes are applied, it logs a structured warning to $TENEX_BASE_DIR/daemon/warn.log
 * and adds an OTel span event for telemetry correlation.
 */
export function createMessageSanitizerMiddleware(): LanguageModelMiddleware {
    return {
        specificationVersion: "v3" as const,

        transformParams: async ({ params, type, model }) => {
            const originalPrompt = params.prompt as LanguageModelV3Message[];
            const originalCount = originalPrompt.length;

            const { result: sanitized, warnings } = sanitize(originalPrompt);

            // No fixes needed — return params unchanged
            if (warnings.length === 0) {
                return params;
            }

            // Build log entry
            const modelId = `${model.provider}:${model.modelId}`;
            const allRemoved = warnings.flatMap((w) => w.removed);

            for (const warning of warnings) {
                const entry = {
                    ts: new Date().toISOString(),
                    type: "message-sanitizer",
                    fix: warning.fix,
                    model: modelId,
                    callType: type,
                    original_count: originalCount,
                    fixed_count: sanitized.length,
                    removed: warning.removed,
                };
                logWarning(entry);
            }

            // OTel span event — skip gracefully if no active span
            const span = trace.getActiveSpan();
            if (span) {
                span.addEvent("message-sanitizer.fix-applied", {
                    "sanitizer.fixes": warnings.map((w) => w.fix).join(","),
                    "sanitizer.original_count": originalCount,
                    "sanitizer.fixed_count": sanitized.length,
                    "sanitizer.removed_indices": allRemoved.map((r) => r.index).join(","),
                    "sanitizer.removed_roles": allRemoved.map((r) => r.role).join(","),
                    "sanitizer.model": modelId,
                    "sanitizer.call_type": type,
                });
            }

            return {
                ...params,
                prompt: sanitized as LanguageModelV3CallOptions["prompt"],
            };
        },
    };
}
