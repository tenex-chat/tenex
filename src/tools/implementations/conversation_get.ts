import type { ExecutionContext } from "@/agents/execution/types";
import type { Conversation } from "@/conversations/types";
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
 * Safely copy data while handling circular references
 * Uses JSON.stringify with a replacer function that tracks seen objects
 * and replaces circular references with '[Circular]'
 */
function safeCopy<T>(data: T): T {
    const seen = new WeakSet();

    const replacer = (_key: string, value: unknown): unknown => {
        if (typeof value === "object" && value !== null) {
            if (seen.has(value)) {
                return "[Circular]";
            }
            seen.add(value);
        }
        return value;
    };

    try {
        return JSON.parse(JSON.stringify(data, replacer));
    } catch {
        // If JSON.stringify still fails, return a safe fallback
        return data;
    }
}

/**
 * Serialize a Conversation object to a JSON-safe plain object
 * Explicitly constructs result field-by-field to avoid copying cyclic properties
 * that may be runtime-attached to the conversation object.
 * Uses safeCopy for nested objects to handle any remaining circular references.
 */
function serializeConversation(conversation: Conversation): Record<string, unknown> {
    // Convert agentStates Map to object first, then safeCopy
    const agentStatesObj = conversation.agentStates
        ? Object.fromEntries(conversation.agentStates.entries())
        : {};

    return {
        id: conversation.id,
        title: conversation.title,
        phase: conversation.phase,
        phaseStartedAt: conversation.phaseStartedAt,
        metadata: conversation.metadata ? safeCopy(conversation.metadata) : {},
        executionTime: conversation.executionTime ? safeCopy(conversation.executionTime) : {
            totalSeconds: 0,
            isActive: false,
            lastUpdated: Date.now()
        },
        agentStates: safeCopy(agentStatesObj),
        history: conversation.history.map(event => ({
            id: event.id,
            kind: event.kind,
            pubkey: event.pubkey,
            content: event.content,
            created_at: event.created_at,
            tags: safeCopy(event.tags),
            sig: event.sig
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
        messageCount: conversation.history.length,
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
