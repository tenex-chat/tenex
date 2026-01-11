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
 * System prompt type for Claude Code.
 * Can be a string for custom system prompt, or use preset with append for
 * Claude Code's built-in instructions plus custom content.
 */
export type ClaudeCodeSystemPrompt = string | {
    type: 'preset';
    preset: 'claude_code';
    append?: string;
};

/**
 * Compiles system messages for Claude Code's systemPrompt.append.
 * Uses the new systemPrompt API (replacing deprecated customSystemPrompt/appendSystemPrompt).
 *
 * IMPORTANT: Only system messages are included in systemPrompt.append.
 * User/assistant messages are passed separately via the messages array to streamText().
 * This separation is critical for session resumption to work correctly - if conversation
 * history is duplicated in both systemPrompt.append AND messages, it creates a session
 * state that can't be reconstructed on resume.
 *
 * Note: Multimodal content (images) is converted to text descriptions since
 * Claude Code uses a text-based prompt compilation approach.
 */
export function compileMessagesForClaudeCode(messages: ModelMessage[]): {
    systemPrompt?: ClaudeCodeSystemPrompt;
} {
    if (messages.length === 0) {
        return { systemPrompt: undefined };
    }

    // Extract only system messages - user/assistant go in messages array
    const systemMessages = messages.filter((m) => m.role === "system");

    if (systemMessages.length === 0) {
        return { systemPrompt: undefined };
    }

    // Combine all system messages into the append content
    const appendParts: string[] = [];

    for (const msg of systemMessages) {
        const content =
            typeof msg.content === "string"
                ? msg.content
                : extractTextContent(msg.content);
        appendParts.push(content);
    }

    const appendContent = appendParts.join("\n\n");

    // Use Claude Code's built-in preset with our system content appended
    return {
        systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: appendContent,
        },
    };
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
