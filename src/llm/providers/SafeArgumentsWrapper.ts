/**
 * Wrapper for LLM providers that fixes empty string arguments issue
 * 
 * Some LLM providers return empty string "" for tool arguments when there are no parameters.
 * This causes JSON.parse to fail in multi-llm-ts. This wrapper intercepts and fixes the issue.
 */

import { logger } from "@/utils/logger";

/**
 * Proxy handler that intercepts and fixes tool call arguments
 */
class SafeArgumentsHandler implements ProxyHandler<any> {
    constructor(target: any) {}

    get(target: any, prop: string | symbol, receiver: any): any {
        const value = Reflect.get(target, prop, receiver);
        
        // Intercept methods that might return tool calls
        if (typeof value === 'function' && (prop === 'complete' || prop === 'generate')) {
            return new Proxy(value, {
                apply: async (method, thisArg, args) => {
                    try {
                        const result = await method.apply(thisArg, args);
                        
                        // For complete method, check if we have tool calls
                        if (prop === 'complete' && result?.toolCalls) {
                            result.toolCalls = result.toolCalls.map((toolCall: any) => {
                                if (toolCall.function?.arguments === "") {
                                    logger.debug(`[SafeArgumentsWrapper] Fixed empty arguments for tool: ${toolCall.function.name}`);
                                    return {
                                        ...toolCall,
                                        function: {
                                            ...toolCall.function,
                                            arguments: "{}"
                                        }
                                    };
                                }
                                return toolCall;
                            });
                        }
                        
                        // For generate method (streaming), we need to wrap the async iterator
                        if (prop === 'generate' && result && typeof result[Symbol.asyncIterator] === 'function') {
                            return this.wrapAsyncIterator(result);
                        }
                        
                        return result;
                    } catch (error) {
                        // Check if it's our specific error
                        if (error instanceof Error && error.message.includes('invalid JSON args: ""')) {
                            logger.warn(`[SafeArgumentsWrapper] Caught empty args error, retrying with empty object`);
                            // We can't really fix this here since the error already happened
                            // This needs to be fixed at a lower level
                        }
                        throw error;
                    }
                }
            });
        }
        
        return value;
    }
    
    private async *wrapAsyncIterator(iterator: AsyncIterable<any>) {
        for await (const chunk of iterator) {
            // Fix tool chunks with empty arguments
            if (chunk?.type === 'tool' && chunk?.call?.params === "") {
                logger.debug(`[SafeArgumentsWrapper] Fixed empty params in stream for tool: ${chunk.name}`);
                yield {
                    ...chunk,
                    call: {
                        ...chunk.call,
                        params: {}
                    }
                };
            } else {
                yield chunk;
            }
        }
    }
}

/**
 * Wrap an LLM engine to handle empty arguments safely
 */
export function wrapWithSafeArguments<T>(engine: T): T {
    return new Proxy(engine, new SafeArgumentsHandler(engine));
}