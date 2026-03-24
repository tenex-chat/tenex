import type { ModelMessage } from "ai";

/**
 * Prepare messages for sending to the LLM.
 * Prompt caching is handled through request-level provider options,
 * so message content is left unchanged.
 */
export function prepareMessagesForRequest(messages: ModelMessage[], _provider: string): ModelMessage[] {
    return messages;
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
 * Used for telemetry and provider-agnostic prompt inspection.
 */
export function extractSystemContent(messages: ModelMessage[]): string {
    return messages
        .filter((m) => m.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n\n");
}
