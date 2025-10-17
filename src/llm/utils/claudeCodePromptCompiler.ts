import type { ModelMessage } from "ai";
import { logger } from "@/utils/logger";

/**
 * Compiles messages for Claude Code when NOT resuming.
 * Extracts first system message as customSystemPrompt,
 * compiles remaining messages (preserving order) as appendSystemPrompt.
 */
export function compileMessagesForClaudeCode(messages: ModelMessage[]): {
    customSystemPrompt?: string;
    appendSystemPrompt?: string;
} {
    logger.info("[claudeCodePromptCompiler] 📝 COMPILING MESSAGES FOR CLAUDE CODE", {
        messageCount: messages.length,
        messageRoles: messages.map(m => m.role),
        firstMessageRole: messages[0]?.role,
        firstMessageLength: messages[0]?.content?.length || 0,
    });

    if (messages.length === 0) {
        logger.info("[claudeCodePromptCompiler] No messages to compile");
        return { customSystemPrompt: undefined, appendSystemPrompt: undefined };
    }

    // Find first system message for customSystemPrompt
    const firstSystemIndex = messages.findIndex(m => m.role === "system");
    const customSystemPrompt = firstSystemIndex !== -1 ? messages[firstSystemIndex].content : undefined;

    // Compile ALL remaining messages (after first system) preserving order
    const appendParts: string[] = [];
    let messagesToConcatenate = 0;

    if (firstSystemIndex !== -1 && messages.length > firstSystemIndex + 1) {
        messagesToConcatenate = messages.length - firstSystemIndex - 1;
        logger.info("[claudeCodePromptCompiler] 🔗 CONCATENATING MESSAGES (after first system)", {
            totalMessages: messages.length,
            firstSystemIndex,
            messagesToConcatenate,
            messageTypes: messages.slice(firstSystemIndex + 1).map(m => m.role),
        });

        appendParts.push("=== Conversation History ===\n\n");

        // Process all messages after the first system message, preserving order
        for (let i = firstSystemIndex + 1; i < messages.length; i++) {
            const msg = messages[i];
            const roleLabel = msg.role === "system" ? "[System]" :
                            msg.role === "user" ? "[User]" : "[Assistant]";
            appendParts.push(`${roleLabel}: ${msg.content}\n\n`);

            const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            logger.debug("[claudeCodePromptCompiler] Adding message to append", {
                index: i,
                role: msg.role,
                contentLength: contentStr.length,
                contentPreview: contentStr.substring(0, 200),
            });
        }

        appendParts.push("=== End History ===\n");
    } else if (firstSystemIndex === -1 && messages.length > 0) {
        // No system message found, include all messages
        messagesToConcatenate = messages.length;
        logger.info("[claudeCodePromptCompiler] 🔗 CONCATENATING ALL MESSAGES (no system message)", {
            totalMessages: messages.length,
            messagesToConcatenate,
            messageTypes: messages.map(m => m.role),
        });

        appendParts.push("=== Conversation History ===\n\n");

        for (const msg of messages) {
            const roleLabel = msg.role === "system" ? "[System]" :
                            msg.role === "user" ? "[User]" : "[Assistant]";
            appendParts.push(`${roleLabel}: ${msg.content}\n\n`);
        }

        appendParts.push("=== End History ===\n");
    }

    const appendSystemPrompt = appendParts.length > 0 ? appendParts.join("") : undefined;

    logger.info("[claudeCodePromptCompiler] 📦 COMPILED PROMPTS", {
        customSystemPromptLength: customSystemPrompt?.length || 0,
        appendSystemPromptLength: appendSystemPrompt?.length || 0,
        hasCustomPrompt: !!customSystemPrompt,
        hasAppendPrompt: !!appendSystemPrompt,
        customSystemPromptPreview: customSystemPrompt?.substring(0, 500),
        appendSystemPromptPreview: appendSystemPrompt?.substring(0, 500),
    });

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

    logger.info("[claudeCodePromptCompiler] 🔄 CONVERTING MESSAGES FOR RESUME", {
        messageCount: messages.length,
        messageRoles: messages.map(m => m.role),
    });

    // Find the first non-system message (start of conversation)
    const conversationStartIndex = messages.findIndex(m => m.role !== "system");

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
            const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            logger.debug("[claudeCodePromptCompiler] Converting system message to user", {
                index,
                contentPreview: contentStr.substring(0, 100),
            });
            return {
                role: "user",
                content: `[System Context]: ${msg.content}`
            };
        }

        // Keep user and assistant messages as-is
        return msg;
    });

    const systemMessagesConverted = messages.filter((msg, index) =>
        index >= conversationStartIndex && msg.role === "system"
    ).length;

    logger.info("[claudeCodePromptCompiler] ✅ RESUME CONVERSION COMPLETE", {
        originalMessages: messages.length,
        conversationStartIndex,
        systemMessagesConverted,
        resultingRoles: convertedMessages.map(m => m.role),
    });

    return convertedMessages;
}