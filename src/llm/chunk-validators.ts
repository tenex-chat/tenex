import { trace } from "@opentelemetry/api";
import type { TextStreamPart } from "ai";
import type { AISdkTool } from "@/tools/types";

type StreamChunk = TextStreamPart<Record<string, AISdkTool>>;

interface ChunkValidator {
    name: string;
    shouldIgnore: (chunk: StreamChunk) => boolean;
}

/**
 * Validates reasoning-delta chunks with [REDACTED] content.
 * Some LLM providers (e.g., OpenRouter with Gemini) send encrypted reasoning
 * data that appears as "[REDACTED]" - these should be ignored.
 */
const redactedReasoningValidator: ChunkValidator = {
    name: "redacted-reasoning",
    shouldIgnore: (chunk: StreamChunk): boolean => {
        if (chunk.type !== "reasoning-delta") {
            return false;
        }

        // The chunk may have 'text' or 'delta' property depending on how AI SDK processes it
        const content = (chunk as { text?: string; delta?: string }).text
            ?? (chunk as { text?: string; delta?: string }).delta;

        return content === "[REDACTED]";
    },
};

/**
 * All chunk validators to apply before processing
 */
const validators: ChunkValidator[] = [
    redactedReasoningValidator,
];

/**
 * Check if a chunk should be ignored based on all validators.
 * Adds an OTL span event when a chunk is ignored for debugging.
 *
 * @returns true if the chunk should be ignored, false otherwise
 */
export function shouldIgnoreChunk(chunk: StreamChunk): boolean {
    for (const validator of validators) {
        if (validator.shouldIgnore(chunk)) {
            const activeSpan = trace.getActiveSpan();
            activeSpan?.addEvent("chunk_ignored", {
                "chunk.type": chunk.type,
                "validator.name": validator.name,
            });
            return true;
        }
    }
    return false;
}
