import type { ModelMessage } from "ai";

export function normalizeMessagesForContextManagement(
    messages: ModelMessage[]
): ModelMessage[] {
    return messages.map((message) => {
        if (
            message.role === "system"
            || message.role === "tool"
            || Array.isArray(message.content)
        ) {
            return message;
        }

        // ai-sdk-context-management currently clones prompt content as v3 parts.
        // TENEX still emits legacy string content for plain user/assistant turns.
        return {
            ...message,
            content: message.content.length > 0
                ? [{ type: "text", text: message.content }]
                : [],
        } as ModelMessage;
    });
}
