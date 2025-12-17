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
    conversation?: Record<string, any>;
    message?: string;
}

/**
 * Serialize a Conversation object to a JSON-safe plain object
 * Handles circular references in NDKEvent objects and converts Map to plain object
 */
function serializeConversation(conversation: Conversation): Record<string, any> {
    return {
        ...conversation,
        agentStates: conversation.agentStates
            ? Object.fromEntries(conversation.agentStates.entries())
            : {},
        history: conversation.history.map(event => ({
            id: event.id,
            kind: event.kind,
            pubkey: event.pubkey,
            content: event.content,
            created_at: event.created_at,
            tags: event.tags,
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
