import { trace } from "@opentelemetry/api";
import type { TextStreamPart } from "ai";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";

type StreamChunk = TextStreamPart<Record<string, AISdkTool>>;

interface ChunkValidator {
    name: string;
    shouldIgnore: (chunk: StreamChunk) => boolean;
}

/**
 * Type guard to check if a chunk has text or delta properties
 */
function hasReasoningContent(chunk: StreamChunk): chunk is StreamChunk & { text?: string; delta?: string } {
    return "text" in chunk || "delta" in chunk;
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

        // Type guard for better safety
        if (!hasReasoningContent(chunk)) {
            const activeSpan = trace.getActiveSpan();
            activeSpan?.addEvent("chunk_validator.unexpected_structure", {
                "chunk.type": chunk.type,
                "chunk.keys": Object.keys(chunk).join(","),
                "validator.name": "redacted-reasoning",
            });
            logger.warn("[ChunkValidator] Unexpected reasoning-delta chunk structure", {
                chunkType: chunk.type,
                chunkKeys: Object.keys(chunk),
            });
            return false;
        }

        // The chunk may have 'text' or 'delta' property depending on how AI SDK processes it
        const content = chunk.text ?? chunk.delta;

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
