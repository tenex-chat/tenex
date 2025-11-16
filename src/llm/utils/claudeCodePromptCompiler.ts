import type { ModelMessage } from "ai";

/**
 * Compiles messages for Claude Code when NOT resuming.
 * Extracts first system message as customSystemPrompt,
 * compiles remaining messages (preserving order) as appendSystemPrompt.
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
        firstSystemIndex !== -1 ? messages[firstSystemIndex].content : undefined;

    // Compile ALL remaining messages (after first system) preserving order
    const appendParts: string[] = [];

    if (firstSystemIndex !== -1 && messages.length > firstSystemIndex + 1) {
        appendParts.push("=== Conversation History ===\n\n");

        // Process all messages after the first system message, preserving order
        for (let i = firstSystemIndex + 1; i < messages.length; i++) {
            const msg = messages[i];
            const roleLabel =
                msg.role === "system" ? "[System]" : msg.role === "user" ? "[User]" : "[Assistant]";
            appendParts.push(`${roleLabel}: ${msg.content}\n\n`);
        }

        appendParts.push("=== End History ===\n");
    } else if (firstSystemIndex === -1 && messages.length > 0) {
        // No system message found, include all messages
        appendParts.push("=== Conversation History ===\n\n");

        for (const msg of messages) {
            const roleLabel =
                msg.role === "system" ? "[System]" : msg.role === "user" ? "[User]" : "[Assistant]";
            appendParts.push(`${roleLabel}: ${msg.content}\n\n`);
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
            return {
                role: "user",
                content: `[System Context]: ${msg.content}`,
            };
        }

        // Keep user and assistant messages as-is
        return msg;
    });

    return convertedMessages;
}
