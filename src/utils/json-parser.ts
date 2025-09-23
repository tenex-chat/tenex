import { logger } from "@/utils/logger";

/**
 * Safely parse JSON with markdown code block cleanup
 * @param text The text to parse, potentially containing markdown code blocks
 * @param context Optional context for error logging
 * @returns Parsed object or null if parsing fails
 */
export function safeParseJSON<T = any>(text: string, context?: string): T | null {
    try {
        // Clean up response - remove markdown code blocks if present
        let cleanText = text.trim();
        
        // Remove ```json or ``` wrapper if present
        if (cleanText.startsWith('```json')) {
            cleanText = cleanText.replace(/^```json\s*/, '').replace(/```\s*$/, '');
        } else if (cleanText.startsWith('```')) {
            cleanText = cleanText.replace(/^```\s*/, '').replace(/```\s*$/, '');
        }
        
        return JSON.parse(cleanText);
    } catch (error) {
        if (context) {
            logger.error(`[JSON Parser] Failed to parse JSON in ${context}`, {
                error: error instanceof Error ? error.message : String(error),
                text: text.substring(0, 200)
            });
        }
        return null;
    }
}