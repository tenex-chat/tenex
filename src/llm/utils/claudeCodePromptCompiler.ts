import type { ModelMessage, TextPart, ImagePart } from "ai";

/**
 * Extract text content from a message content field.
 * Handles both string content and multimodal content (TextPart + ImagePart arrays).
 *
 * For multimodal content, extracts the text part and notes any images.
 */
function extractTextContent(content: ModelMessage["content"]): string {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return JSON.stringify(content);
    }

    // Handle multimodal content (arrays of parts)
    const parts: string[] = [];
    let imageCount = 0;

    for (const part of content) {
        if ((part as TextPart).type === "text") {
            parts.push((part as TextPart).text);
        } else if ((part as ImagePart).type === "image") {
            imageCount++;
        }
    }

    // If there were images, note them at the end
    if (imageCount > 0) {
        parts.push(`[${imageCount} image${imageCount > 1 ? "s" : ""} attached]`);
    }

    return parts.join("\n");
}

/**
 * Compiles messages for Claude Code when NOT resuming.
 * Extracts first system message as customSystemPrompt,
 * compiles remaining messages (preserving order) as appendSystemPrompt.
 *
 * Note: Multimodal content (images) is converted to text descriptions since
 * Claude Code uses a text-based prompt compilation approach.
 */
export function compileMessagesForClaudeCode(messages: ModelMessage[]): {
    customSystemPrompt?: string;
    appendSystemPrompt?: string;
} {
    if (messages.length === 0) {
        return { customSystemPrompt: undefined, appendSystemPrompt: undefined };
    }

    // Find first system message for customSystemPrompt
    const firstSystemIndex = messages.findIndex((m) => m.role === "system");
    const customSystemPrompt =
        firstSystemIndex !== -1
            ? typeof messages[firstSystemIndex].content === "string"
                ? messages[firstSystemIndex].content
                : extractTextContent(messages[firstSystemIndex].content)
            : undefined;

    // Compile ALL remaining messages (after first system) preserving order
    const appendParts: string[] = [];

    if (firstSystemIndex !== -1 && messages.length > firstSystemIndex + 1) {
        appendParts.push("=== Conversation History ===\n\n");

        // Process all messages after the first system message, preserving order
        for (let i = firstSystemIndex + 1; i < messages.length; i++) {
            const msg = messages[i];
            const roleLabel =
                msg.role === "system" ? "[System]" : msg.role === "user" ? "[User]" : "[Assistant]";
            const textContent = extractTextContent(msg.content);
            appendParts.push(`${roleLabel}: ${textContent}\n\n`);
        }

        appendParts.push("=== End History ===\n");
    } else if (firstSystemIndex === -1 && messages.length > 0) {
        // No system message found, include all messages
        appendParts.push("=== Conversation History ===\n\n");

        for (const msg of messages) {
            const roleLabel =
                msg.role === "system" ? "[System]" : msg.role === "user" ? "[User]" : "[Assistant]";
            const textContent = extractTextContent(msg.content);
            appendParts.push(`${roleLabel}: ${textContent}\n\n`);
        }

        appendParts.push("=== End History ===\n");
    }

    const appendSystemPrompt = appendParts.length > 0 ? appendParts.join("") : undefined;

    return { customSystemPrompt, appendSystemPrompt };
}

/**
 * Converts system messages to user messages for active Claude Code sessions.
 * When resuming a session, Claude Code doesn't receive new system messages,
 * so we convert them to user messages to ensure they're delivered.
 *
 * Note: Multimodal content is preserved for user messages (they support images),
 * but system messages with multimodal content are converted to text descriptions.
 */
export function convertSystemMessagesForResume(messages: ModelMessage[]): ModelMessage[] {
    // For resuming sessions, we need to convert system messages that appear
    // after the conversation started into user messages

    // Find the first non-system message (start of conversation)
    const conversationStartIndex = messages.findIndex((m) => m.role !== "system");

    if (conversationStartIndex === -1) {
        // All messages are system messages, no conversion needed
        return messages;
    }

    // Convert messages, preserving order
    const convertedMessages = messages.map((msg, index) => {
        // Keep initial system messages as-is (they were part of initial prompt)
        if (index < conversationStartIndex) {
            return msg;
        }

        // Convert subsequent system messages to user messages with clear marker
        if (msg.role === "system") {
            // Use extractTextContent to handle multimodal content gracefully
            const content = extractTextContent(msg.content);
            return {
                role: "user" as const,
                content: `[System Context]: ${content}`,
            };
        }

        // Keep user and assistant messages as-is (preserving multimodal content)
        return msg;
    });

    return convertedMessages as ModelMessage[];
}
