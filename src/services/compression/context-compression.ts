import {
    contextCompression,
    defaultToolPolicy,
    type ContextCompressionMessage,
} from "ai-sdk-context-management";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { AddressableModelMessage } from "@/conversations/MessageBuilder";

function mapProtectedTailCount(slidingWindowSize: number): number {
    // Keep this bounded: the legacy config is a raw sliding-window size, while
    // the new preprocessor uses a protected tail count.
    return Math.max(4, Math.min(12, slidingWindowSize));
}

export async function applyTenexContextCompression(options: {
    messages: AddressableModelMessage[];
    conversationStore: ConversationStore;
    conversationId: string;
    maxTokens: number;
    slidingWindowSize: number;
}): Promise<AddressableModelMessage[]> {
    const result = await contextCompression({
        messages: options.messages as unknown as ContextCompressionMessage[],
        maxTokens: options.maxTokens,
        compressionThreshold: 1,
        protectedTailCount: mapProtectedTailCount(options.slidingWindowSize),
        conversationKey: options.conversationId,
        segmentStore: {
            load: () => options.conversationStore.loadCompressionLog(options.conversationId).map((segment) => ({
                fromId: segment.fromEventId,
                toId: segment.toEventId,
                compressed: segment.compressed,
                createdAt: segment.createdAt,
                metadata: {
                    model: segment.model,
                },
            })),
        },
        toolPolicy: defaultToolPolicy,
        retrievalToolName: "fs_read",
        retrievalToolArgName: "tool",
    });

    return result.messages as unknown as AddressableModelMessage[];
}
