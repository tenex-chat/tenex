import { formatAnyError } from "./error-formatter";
import { logError } from "./logger";
import type { LogModule } from "./logger";

/**
 * Safely execute an async function with error handling
 */
export async function safeExecute<T>(
    fn: () => Promise<T>,
    options?: {
        fallback?: T;
        module?: LogModule;
        context?: string;
        rethrow?: boolean;
    }
): Promise<T | undefined> {
    try {
        return await fn();
    } catch (error) {
        const errorMessage = formatAnyError(error);
        const contextMessage = options?.context ? `[${options.context}] ` : "";
        
        logError(`${contextMessage}${errorMessage}`, options?.module || "general");
        
        if (options?.rethrow) {
            throw error;
        }
        
        return options?.fallback;
    }
}

/**
 * Safely execute a sync function with error handling
 */
export function safeExecuteSync<T>(
    fn: () => T,
    options?: {
        fallback?: T;
        module?: LogModule;
        context?: string;
        rethrow?: boolean;
    }
): T | undefined {
    try {
        return fn();
    } catch (error) {
        const errorMessage = formatAnyError(error);
        const contextMessage = options?.context ? `[${options.context}] ` : "";
        
        logError(`${contextMessage}${errorMessage}`, options?.module || "general");
        
        if (options?.rethrow) {
            throw error;
        }
        
        return options?.fallback;
    }
}

/**
 * Wrap an async function to automatically handle errors
 */
export function withErrorHandling<T extends unknown[], R>(
    fn: (...args: T) => Promise<R>,
    options?: {
        module?: LogModule;
        context?: string;
    }
): (...args: T) => Promise<R | undefined> {
    return async (...args: T) => {
        return safeExecute(() => fn(...args), options);
    };
}