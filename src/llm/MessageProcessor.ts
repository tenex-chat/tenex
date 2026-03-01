import type { ModelMessage } from "ai";
import { PROVIDER_IDS } from "./providers/provider-ids";

/**
 * Add provider-specific cache control to messages.
 * Only Anthropic requires explicit cache control; OpenAI and Gemini cache automatically.
 */
export function addCacheControl(messages: ModelMessage[], provider: string): ModelMessage[] {
    // Only add cache control for Anthropic
    if (provider !== PROVIDER_IDS.ANTHROPIC) {
        return messages;
    }

    // Rough estimate: 4 characters per token (configurable if needed)
    const CHARS_PER_TOKEN_ESTIMATE = 4;
    const MIN_TOKENS_FOR_CACHE = 1024;
    const minCharsForCache = MIN_TOKENS_FOR_CACHE * CHARS_PER_TOKEN_ESTIMATE;

    return messages.map((msg) => {
        // Only cache system messages and only if they're large enough
        if (msg.role === "system" && typeof msg.content === "string" && msg.content.length > minCharsForCache) {
            return {
                ...msg,
                providerOptions: {
                    anthropic: {
                        cacheControl: { type: "ephemeral" },
                    },
                },
            };
        }
        return msg;
    });
}

/**
 * Prepare messages for sending to the LLM.
 * Handles provider-specific transformations.
 */
export function prepareMessagesForRequest(messages: ModelMessage[], provider: string): ModelMessage[] {
    let processedMessages = messages;

    // For Claude Code, filter out system messages since they're passed via systemPrompt
    if (provider === PROVIDER_IDS.CLAUDE_CODE) {
        processedMessages = messages.filter((m) => m.role !== "system");
    }

    return addCacheControl(processedMessages, provider);
}

/**
 * Extract the last user message text from a message array.
 * Handles both simple string content and complex content arrays.
 */
export function extractLastUserMessage(messages: ModelMessage[]): string | undefined {
    // Find the last message with role "user" (iterate from end)
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "user") {
            // User messages can have string content or content array
            if (typeof msg.content === "string") {
                return msg.content;
            }
            if (Array.isArray(msg.content)) {
                // Extract text from content parts
                const textParts = msg.content
                    .filter((part): part is { type: "text"; text: string } =>
                        part.type === "text" && typeof part.text === "string"
                    )
                    .map((part) => part.text);
                if (textParts.length > 0) {
                    return textParts.join("\n");
                }
            }
            // Found user message but couldn't extract text
            return "[User message with non-text content]";
        }
    }
    return undefined;
}

/**
 * Extract system messages from a message array and combine them.
 * Used for providers like Claude Code that take system prompt separately.
 */
export function extractSystemContent(messages: ModelMessage[]): string {
    return messages
        .filter((m) => m.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n\n");
}
