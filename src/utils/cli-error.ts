import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "./logger";

/**
 * Centralized CLI error handler that ensures consistent error logging and exit behavior
 * @param error - The error object or message
 * @param context - Optional context for better error reporting
 * @param exitCode - The process exit code (default: 1)
 */
export function handleCliError(error: unknown, context?: string, exitCode = 1): never {
    const errorMessage = formatAnyError(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    // Log error with context
    if (context) {
        logger.error(`${context}: ${errorMessage}`);
    } else {
        logger.error(errorMessage);
    }

    // Log stack trace in debug mode
    if (errorStack && process.env.DEBUG) {
        logger.debug(errorStack);
    }

    // Exit with specified code
    process.exit(exitCode);
}

/**
 * Handle CLI warnings without exiting
 * @param message - The warning message
 * @param context - Optional context for the warning
 */
export function handleCliWarning(message: string, context?: string): void {
    if (context) {
        logger.warn(`${context}: ${message}`);
    } else {
        logger.warn(message);
    }
}
