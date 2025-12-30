import type { ExecutionContext } from "@/agents/execution/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const conversationGetSchema = z.object({
    conversationId: z
        .string()
        .optional()
        .describe(
            "The conversation ID to retrieve. If omitted, returns the current conversation."
        ),
});

type ConversationGetInput = z.infer<typeof conversationGetSchema>;

interface ConversationGetOutput {
    success: boolean;
    conversation?: Record<string, unknown>;
    message?: string;
}

/**
 * Recursively deep copy an object while handling cycles, BigInts, Maps, Sets, and other edge cases
 */
function safeDeepCopy(obj: unknown, seen = new WeakSet()): unknown {
    // Handle primitives and special values
    if (obj === null || typeof obj !== 'object') {
        if (typeof obj === 'bigint') return obj.toString();
        if (typeof obj === 'function') return undefined;
        return obj;
    }

    // Cycle detection
    if (seen.has(obj)) {
        return '[Circular]';
    }
    seen.add(obj);

    // Handle Arrays
    if (Array.isArray(obj)) {
        return obj.map(item => safeDeepCopy(item, seen));
    }

    // Handle Maps
    if (obj instanceof Map) {
        const result: Record<string, unknown> = {};
        for (const [key, value] of obj) {
            result[String(key)] = safeDeepCopy(value, seen);
        }
        return result;
    }

    // Handle Sets
    if (obj instanceof Set) {
        return Array.from(obj).map(item => safeDeepCopy(item, seen));
    }

    // Handle Dates
    if (obj instanceof Date) {
        return obj.toISOString();
    }

    // Handle plain Objects
    const result: Record<string, unknown> = {};
    for (const key in obj) {
        // Only process own properties
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            try {
                result[key] = safeDeepCopy((obj as Record<string, unknown>)[key], seen);
            } catch {
                result[key] = '[Access Error]';
            }
        }
    }
    return result;
}

/**
 * Safely copy data while handling circular references, BigInts, Maps, Sets, and other edge cases
 * Uses recursive deep copy with cycle detection instead of JSON.stringify
 */
function safeCopy<T>(data: T): T {
    try {
        return safeDeepCopy(data) as T;
    } catch {
        // Fallback to string representation if even deep copy fails
        return '[Serialization Failed]' as unknown as T;
    }
}

/**
 * Serialize a Conversation object to a JSON-safe plain object
 * Explicitly constructs result field-by-field to avoid copying cyclic properties
 * that may be runtime-attached to the conversation object.
 * Uses safeCopy for nested objects and strict primitive enforcement for fields
 * that should always be primitives (preventing accidental circular object serialization).
 */
function serializeConversation(conversation: ConversationStore): Record<string, unknown> {
    const messages = conversation.getAllMessages();

    return {
        // Strictly enforce primitive types for top-level fields
        id: String(conversation.id),
        title: conversation.title ? String(conversation.title) : undefined,
        phase: conversation.phase ? String(conversation.phase) : undefined,
        phaseStartedAt: typeof conversation.metadata.phaseStartedAt === 'number'
            ? conversation.metadata.phaseStartedAt
            : undefined,
        metadata: conversation.metadata ? safeCopy(conversation.metadata) : {},
        executionTime: safeCopy(conversation.executionTime),
        messageCount: messages.length,
        messages: messages.map(entry => ({
            role: entry.message.role,
            content: typeof entry.message.content === 'string'
                ? entry.message.content
                : JSON.stringify(entry.message.content),
            pubkey: entry.pubkey,
            eventId: entry.eventId,
            timestamp: entry.timestamp,
        }))
    };
}

/**
 * Core implementation of conversation retrieval functionality
 */
async function executeConversationGet(
    input: ConversationGetInput,
    context: ExecutionContext
): Promise<ConversationGetOutput> {
    const targetConversationId = input.conversationId || context.conversationId;

    logger.info("📖 Retrieving conversation", {
        conversationId: targetConversationId,
        isCurrentConversation: targetConversationId === context.conversationId,
        agent: context.agent.name,
    });

    // Get conversation from coordinator
    const conversation =
        targetConversationId === context.conversationId
            ? context.getConversation()
            : context.conversationCoordinator.getConversation(targetConversationId);

    if (!conversation) {
        logger.info("📭 Conversation not found", {
            conversationId: targetConversationId,
            agent: context.agent.name,
        });

        return {
            success: false,
            message: `Conversation ${targetConversationId} not found`,
        };
    }

    logger.info("✅ Conversation retrieved successfully", {
        conversationId: conversation.id,
        title: conversation.title,
        messageCount: conversation.getMessageCount(),
        phase: conversation.phase,
        agent: context.agent.name,
    });

    return {
        success: true,
        conversation: serializeConversation(conversation),
    };
}

/**
 * Create an AI SDK tool for retrieving conversations
 */
export function createConversationGetTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Retrieve a conversation by its ID, including all messages/events in the conversation history. Returns conversation metadata, execution state, and full message history. If conversationId is omitted, returns the current conversation. Useful for reviewing conversation context, analyzing message history, or accessing conversation metadata like phase, summary, requirements, and plan.",

        inputSchema: conversationGetSchema,

        execute: async (input: ConversationGetInput) => {
            return await executeConversationGet(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ conversationId }: ConversationGetInput) => {
            return conversationId
                ? `Retrieving conversation: ${conversationId}`
                : "Retrieving current conversation";
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
