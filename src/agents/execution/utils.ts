import type { ModelMessage } from "ai";

/**
 * Extract the text content from the last user message in the conversation.
 * Handles both simple string content and complex content arrays (with text parts).
 */
export function extractLastUserMessage(messages: ModelMessage[]): string | undefined {
    // Find the last user message
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "user") {
            // Handle simple string content
            if (typeof msg.content === "string") {
                return msg.content;
            }
            // Handle complex content arrays (e.g., [{ type: "text", text: "hello" }])
            if (Array.isArray(msg.content)) {
                const textParts = msg.content
                    .filter((part): part is { type: "text"; text: string } => part.type === "text")
                    .map(part => part.text);
                return textParts.join("\n");
            }
        }
    }
    return undefined;
}
