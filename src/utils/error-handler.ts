import { formatAnyError } from "./error-formatter";
import { logger } from "./logger";

/**
 * Standard error handling utility for consistent error management
 * across the codebase
 */
export function handleError(
    error: unknown,
    context: string,
    options?: {
        logLevel?: "error" | "warn" | "debug";
        rethrow?: boolean;
        exitCode?: number;
    }
): string {
    const message = formatAnyError(error);
    const logLevel = options?.logLevel ?? "error";

    switch (logLevel) {
        case "error":
            logger.error(`${context}: ${message}`);
            break;
        case "warn":
            logger.warn(`${context}: ${message}`);
            break;
        case "debug":
            logger.debug(`${context}: ${message}`);
            break;
    }

    if (options?.exitCode !== undefined) {
        process.exit(options.exitCode);
    }

    if (options?.rethrow) {
        throw error;
    }

    return message;
}

/**
 * Async wrapper for error handling
 */
export async function withErrorHandling<T>(
    fn: () => Promise<T>,
    context: string,
    options?: {
        fallback?: T;
        logLevel?: "error" | "warn" | "debug";
        rethrow?: boolean;
    }
): Promise<T | undefined> {
    try {
        return await fn();
    } catch (error) {
        handleError(error, context, options);
        return options?.fallback;
    }
}
