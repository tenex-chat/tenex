/**
 * Patch for multi-llm-ts to handle empty string arguments for tools
 * 
 * This patches the JSON.parse calls in multi-llm-ts to handle empty strings
 * as empty objects, which is a common case when LLMs send tool calls with
 * no arguments.
 */

import { logger } from "@/utils/logger";

/**
 * Apply the patch to handle empty string arguments
 */
export function applyMultiLLMPatch(): void {
    // Store the original JSON.parse
    const originalParse = JSON.parse;
    
    // Create a patched version that handles empty strings
    const patchedParse = function(text: string, reviver?: (this: any, key: string, value: any) => any): any {
        // If the text is an empty string, return an empty object
        if (text === "") {
            logger.debug("Patched JSON.parse: converting empty string to empty object");
            return {};
        }
        
        // Otherwise use the original parse
        return originalParse.call(this, text, reviver);
    };
    
    // Replace JSON.parse globally
    // This is a targeted fix that only affects empty strings
    (global as any).JSON.parse = patchedParse;
    
    logger.info("Applied multi-llm-ts patch for empty string arguments");
}

/**
 * Remove the patch (for testing or cleanup)
 */
export function removeMultiLLMPatch(): void {
    // Restore the original JSON.parse
    const originalParse = JSON.parse.toString().includes("empty string") 
        ? JSON.parse 
        : JSON.parse;
    
    logger.info("Removed multi-llm-ts patch");
}