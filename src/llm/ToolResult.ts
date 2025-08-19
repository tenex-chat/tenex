/**
 * Serializable representation of tool execution results
 * Preserves type information across LLM boundaries
 */

import type { ToolExecutionResult } from "@/tools/types";
import type { ToolError } from "@/tools/core";

/**
 * Simplified serialized tool result
 */
export interface SerializedToolResult {
    /** Whether the tool execution was successful */
    success: boolean;

    /** Tool execution duration in milliseconds */
    duration: number;
    
    /** The name of the tool that was executed */
    toolName: string;
    
    /** The arguments that were passed to the tool */
    toolArgs: Record<string, unknown>;

    /** The actual result data */
    data: {
        output?: unknown;
        error?: {
            kind: string;
            message: string;
        };
    };
}

/**
 * Serialize a tool result for LLM transport
 */
export function serializeToolResult(result: ToolExecutionResult): SerializedToolResult {
    return {
        success: result.success,
        duration: result.duration,
        toolName: result.toolName,
        toolArgs: result.toolArgs,
        data: {
            output: result.output,
            error: result.error
                ? {
                      kind: result.error.kind,
                      message: result.error.message,
                  }
                : undefined,
        },
    };
}

/**
 * Check if an object is a serialized tool result
 */
export function isSerializedToolResult(obj: unknown): obj is SerializedToolResult {
    return (
        typeof obj === "object" &&
        obj !== null &&
        "success" in obj &&
        "duration" in obj &&
        "toolName" in obj &&
        "toolArgs" in obj &&
        "data" in obj &&
        typeof obj.success === "boolean" &&
        typeof obj.duration === "number" &&
        typeof obj.toolName === "string" &&
        typeof obj.toolArgs === "object"
    );
}

/**
 * Deserialize a tool result back to typed format
 */
function deserializeToolError(
    error: { kind: string; message: string } | undefined
): ToolError | undefined {
    if (!error) return undefined;

    // Create a proper ToolError based on the kind
    switch (error.kind) {
        case "validation":
            return {
                kind: "validation",
                field: "unknown", // We don't serialize the field, so use a default
                message: error.message,
            };
        case "execution":
            return {
                kind: "execution",
                tool: "unknown", // We don't serialize the tool name separately
                message: error.message,
            };
        case "system":
            return {
                kind: "system",
                message: error.message,
            };
        default:
            // If unknown kind, treat as system error
            return {
                kind: "system",
                message: error.message,
            };
    }
}

export function deserializeToolResult(serialized: SerializedToolResult): ToolExecutionResult {
    return {
        success: serialized.success,
        duration: serialized.duration,
        toolName: serialized.toolName,
        toolArgs: serialized.toolArgs,
        output: serialized.data.output,
        error: deserializeToolError(serialized.data.error),
    };
}
