import { isAbsolute, relative, resolve } from "node:path";
import type { ToolExecutionContext } from "@/tools/types";
import { handleError } from "@/utils/error-handler";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";

/**
 * Resolves and validates a file path to ensure it stays within the project boundaries.
 *
 * @param filePath - The file path to validate (can be absolute or relative)
 * @param projectPath - The root project path
 * @returns The resolved absolute path if valid
 * @throws Error if the path would escape the project directory
 */
export function resolveAndValidatePath(filePath: string, projectPath: string): string {
    // Validate projectPath is not empty - this would resolve to process.cwd()
    if (!projectPath) {
        const span = trace.getActiveSpan();
        span?.setAttributes({
            "path.error": "projectPath_empty",
            "path.file_path": filePath,
            "path.project_path": projectPath || "(empty)",
        });
        throw new Error(
            `Cannot resolve path "${filePath}": projectPath is empty. ` +
            "This indicates a bug in the execution context - workingDirectory was not set."
        );
    }

    const fullPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath);
    const relativePath = relative(projectPath, fullPath);

    // Add trace attributes for debugging
    const span = trace.getActiveSpan();
    span?.addEvent("path.resolved", {
        "path.input": filePath,
        "path.project": projectPath,
        "path.resolved": fullPath,
        "path.relative": relativePath,
    });

    if (relativePath.startsWith("..")) {
        throw new Error(`Path outside project directory: ${filePath}`);
    }

    return fullPath;
}

/**
 * Standard response format for tool execution
 */
export interface ToolResponse {
    success: boolean;
    message?: string;
    error?: string;
    data?: unknown;
    [key: string]: unknown;
}

/**
 * Base class for tool execution errors
 */
export class ToolExecutionError extends Error {
    constructor(
        message: string,
        public readonly toolName: string,
        public readonly cause?: Error
    ) {
        super(message);
        this.name = "ToolExecutionError";
    }
}

/**
 * Standard wrapper for tool execution with error handling
 * Provides consistent error handling and response formatting
 */
export async function executeToolWithErrorHandling<TInput>(
    toolName: string,
    input: TInput,
    context: ToolExecutionContext,
    executeFn: (input: TInput, context: ToolExecutionContext) => Promise<ToolResponse>
): Promise<string> {
    logger.debug(`Executing tool: ${toolName}`, { input });

    try {
        const result = await executeFn(input, context);

        if (!result.success) {
            logger.warn(`Tool execution failed: ${toolName}`, {
                error: result.error,
                input,
            });
        }

        return JSON.stringify(result, null, 2);
    } catch (error) {
        // Use project's error handling utilities
        const errorMessage = handleError(error, `Tool execution failed: ${toolName}`, {
            logLevel: "error",
        });

        // Return standardized error response
        const errorResponse: ToolResponse = {
            success: false,
            error: errorMessage,
            toolName,
        };

        return JSON.stringify(errorResponse, null, 2);
    }
}

/**
 * Validate required fields in tool input
 */
export function validateRequiredFields<T extends Record<string, unknown>>(
    input: T,
    requiredFields: (keyof T)[],
    toolName: string
): void {
    const missingFields = requiredFields.filter(
        (field) => input[field] === undefined || input[field] === null
    );

    if (missingFields.length > 0) {
        throw new ToolExecutionError(
            `Missing required fields: ${missingFields.join(", ")}`,
            toolName
        );
    }
}

/**
 * Parse and validate numeric input with constraints
 */
export function parseNumericInput(
    value: number | undefined,
    defaultValue: number,
    constraints?: {
        min?: number;
        max?: number;
        integer?: boolean;
    }
): number {
    const result = value ?? defaultValue;

    if (constraints) {
        if (constraints.min !== undefined && result < constraints.min) {
            throw new Error(`Value ${result} is less than minimum ${constraints.min}`);
        }

        if (constraints.max !== undefined && result > constraints.max) {
            throw new Error(`Value ${result} is greater than maximum ${constraints.max}`);
        }

        if (constraints.integer && !Number.isInteger(result)) {
            throw new Error(`Value ${result} must be an integer`);
        }
    }

    return result;
}

// =============================================================================
// Expected Error Handling Contract
// =============================================================================
//
// PRINCIPLE:
// - Expected failures (ENOENT, EACCES, "not found", etc.) → Return error-text object
// - Unexpected failures (null pointer, invariant violation) → Throw exception
//
// RATIONALE:
// When tools throw exceptions, the AI SDK wraps them in tool-error chunks.
// However, OpenRouter/Gemini providers don't always convert these properly,
// causing silent stream failures. Returning error-text objects ensures the
// error is properly communicated back to the LLM.
// =============================================================================

/**
 * Expected error result type - AI SDK format for tool errors
 * This format is recognized by ChunkHandler and ToolResultUtils
 */
export interface ExpectedErrorResult {
    type: "error-text";
    text: string;
}

/**
 * Expected filesystem error codes that should return error-text instead of throwing
 */
const EXPECTED_FS_ERROR_CODES = new Set(["ENOENT", "EACCES", "EISDIR", "EPERM", "ENOTDIR"]);

/**
 * Check if an error is an expected filesystem error (file not found, permission denied, etc.)
 * These should return error-text objects rather than throwing exceptions.
 */
export function isExpectedFsError(error: unknown): boolean {
    if (error instanceof Error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code !== undefined && EXPECTED_FS_ERROR_CODES.has(code);
    }
    return false;
}

/**
 * Check if an HTTP status code is an expected error (all 4xx client errors)
 * This includes 400-499 range: bad request, unauthorized, forbidden, not found, etc.
 */
export function isExpectedHttpError(status: number): boolean {
    return status >= 400 && status < 500;
}

/**
 * Check if an error message indicates an expected "not found" condition
 */
export function isExpectedNotFoundError(error: unknown): boolean {
    if (error instanceof Error) {
        const message = error.message.toLowerCase();
        return (
            message.includes("not found") ||
            message.includes("does not exist") ||
            message.includes("no such") ||
            message.includes("cannot find")
        );
    }
    return false;
}

/**
 * Create an expected error result object (error-text format)
 * Use this when a tool encounters an expected failure condition.
 */
export function createExpectedError(message: string): ExpectedErrorResult {
    return { type: "error-text", text: message };
}

/**
 * Get a human-readable description of a filesystem error code
 */
export function getFsErrorDescription(code: string | undefined): string {
    switch (code) {
        case "ENOENT":
            return "File or directory not found";
        case "EACCES":
            return "Permission denied";
        case "EISDIR":
            return "Expected a file but found a directory";
        case "EPERM":
            return "Operation not permitted";
        case "ENOTDIR":
            return "Expected a directory but found a file";
        default:
            return "Filesystem error";
    }
}
