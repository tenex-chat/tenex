import type { ModelMessage, ToolCallPart, ToolResultPart } from "ai";
import type { ConversationStore } from "@/conversations/ConversationStore";
import { RALRegistry } from "@/services/ral";

/**
 * Syncs messages from AI SDK's step.messages to ConversationStore.
 * Ensures ConversationStore never misses tool calls/results that the AI SDK tracked.
 *
 * This handles cases where tool-did-execute events don't fire (provider-dependent,
 * e.g., Ollama doesn't emit tool-error chunks), ensuring tool results are never lost.
 *
 * Also clears tool tracking state as a fallback when tool results are observed
 * without corresponding tool-did-execute events.
 */
export class MessageSyncer {
    private conversationId: string;

    constructor(
        private conversationStore: ConversationStore,
        private agentPubkey: string,
        private ralNumber: number
    ) {
        this.conversationId = conversationStore.id;
    }

    /**
     * Sync tool messages from AI SDK to ConversationStore.
     * Call this at the start of prepareStep before rebuilding messages.
     */
    syncFromSDK(messages: ModelMessage[]): void {
        for (const msg of messages) {
            if (msg.role === "assistant" && Array.isArray(msg.content)) {
                this.syncToolCalls(msg.content);
            }
            if (msg.role === "tool" && Array.isArray(msg.content)) {
                this.syncToolResults(msg.content);
            }
        }
    }

    private syncToolCalls(content: unknown[]): void {
        for (const part of content) {
            if (this.isToolCallPart(part)) {
                if (!this.conversationStore.hasToolCall(part.toolCallId)) {
                    this.conversationStore.addMessage({
                        pubkey: this.agentPubkey,
                        ral: this.ralNumber,
                        content: "",
                        messageType: "tool-call",
                        toolData: [part],
                    });
                }
            }
        }
    }

    private syncToolResults(content: unknown[]): void {
        const ralRegistry = RALRegistry.getInstance();

        for (const part of content) {
            if (this.isToolResultPart(part)) {
                if (!this.conversationStore.hasToolResult(part.toolCallId)) {
                    this.conversationStore.addMessage({
                        pubkey: this.agentPubkey,
                        ral: this.ralNumber,
                        content: "",
                        messageType: "tool-result",
                        toolData: [part],
                    });
                }

                // Fallback: Clear tool from activeTools if it wasn't cleared by tool-did-execute.
                // This handles cases where tool-did-execute doesn't fire (provider-dependent).
                // If the tool was already cleared, this is a no-op.
                ralRegistry.clearToolFallback(
                    this.agentPubkey,
                    this.conversationId,
                    this.ralNumber,
                    part.toolCallId
                );
            }
        }
    }

    private isToolCallPart(part: unknown): part is ToolCallPart {
        return (
            typeof part === "object" &&
            part !== null &&
            (part as Record<string, unknown>).type === "tool-call"
        );
    }

    private isToolResultPart(part: unknown): part is ToolResultPart {
        return (
            typeof part === "object" &&
            part !== null &&
            (part as Record<string, unknown>).type === "tool-result"
        );
    }
}
