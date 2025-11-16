import type { FormatterOptions, ThreadNode } from "../ThreadedConversationFormatter";

export class MessageFormatter {
    /**
     * Format a message node according to options
     */
    format(node: ThreadNode, options: FormatterOptions): string {
        let message = node.content;

        // Truncate if in compact mode
        if (options.compactMode) {
            message = this.truncateMessage(message, 100);
        }

        // Add tool call information if present
        if (options.includeToolCalls && node.toolCall) {
            const toolCallStr = node.toolCall.args
                ? `[calls tool: ${node.toolCall.name}(${this.truncateMessage(node.toolCall.args, 50)})]`
                : `[calls tool: ${node.toolCall.name}]`;
            message = `${toolCallStr} ${message}`;
        }

        // Clean up message for single-line display
        if (options.compactMode) {
            message = message.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
        }

        return message;
    }

    private truncateMessage(text: string, maxLength: number): string {
        if (text.length <= maxLength) {
            return text;
        }

        // Try to truncate at a word boundary
        const truncated = text.substring(0, maxLength);
        const lastSpace = truncated.lastIndexOf(" ");

        if (lastSpace > maxLength * 0.7) {
            return truncated.substring(0, lastSpace) + "...";
        }

        return truncated + "...";
    }
}
