import { formatAnyError } from "./error-formatter";
import { createTracingContext, createTracingLogger } from "@/tracing";

// Create a global tracing context for error handling utilities
const errorHandlerContext = createTracingContext("global-error-handler");
const logger = createTracingLogger(errorHandlerContext);

/**
 * Standard error handler for async operations with logging
 */
export async function handleAsyncError<T>(
    operation: () => Promise<T>,
    context: {
        operation: string;
        agent?: string;
        additionalInfo?: Record<string, any>;
    },
    fallback?: T
): Promise<T | undefined> {
    try {
        return await operation();
    } catch (error) {
        logger.error(`Failed to ${context.operation}`, error, {
            agent: context.agent,
            ...context.additionalInfo,
            error: formatAnyError(error)
        });
        
        return fallback;
    }
}

/**
 * Standard error handler for sync operations with logging
 */
export function handleSyncError<T>(
    operation: () => T,
    context: {
        operation: string;
        agent?: string;
        additionalInfo?: Record<string, any>;
    },
    fallback?: T
): T | undefined {
    try {
        return operation();
    } catch (error) {
        logger.error(`Failed to ${context.operation}`, error, {
            agent: context.agent,
            ...context.additionalInfo,
            error: formatAnyError(error)
        });
        
        return fallback;
    }
}

/**
 * Error handler that re-throws after logging
 */
export async function logAndThrow<T>(
    operation: () => Promise<T>,
    context: {
        operation: string;
        agent?: string;
        additionalInfo?: Record<string, any>;
    }
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        logger.error(`Failed to ${context.operation}`, error, {
            agent: context.agent,
            ...context.additionalInfo,
            error: formatAnyError(error)
        });
        
        throw error;
    }
}

/**
 * Retry handler with exponential backoff
 */
export async function retryWithBackoff<T>(
    operation: () => Promise<T>,
    context: {
        operation: string;
        maxRetries?: number;
        initialDelay?: number;
        maxDelay?: number;
        agent?: string;
    }
): Promise<T> {
    const maxRetries = context.maxRetries ?? 3;
    const initialDelay = context.initialDelay ?? 1000;
    const maxDelay = context.maxDelay ?? 10000;
    
    let lastError: any;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            
            if (attempt < maxRetries - 1) {
                const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
                logger.warning(`${context.operation} failed, retrying in ${delay}ms`, {
                    attempt: attempt + 1,
                    maxRetries,
                    agent: context.agent,
                    error: formatAnyError(error)
                });
                
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    logger.error(`${context.operation} failed after ${maxRetries} attempts`, lastError, {
        agent: context.agent,
        error: formatAnyError(lastError)
    });
    
    throw lastError;
}