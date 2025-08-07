import { formatAnyError } from "./error-formatter";

/**
 * @deprecated Use formatAnyError from error-formatter.ts instead
 * This is kept for backward compatibility
 */
export function formatError(error: unknown): string {
    return formatAnyError(error);
}