import type { ExecutionContext } from "@/agents/execution/types";
import type { Conversation } from "@/conversations/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const conversationListSchema = z.object({
    limit: z
        .number()
        .optional()
        .describe("Maximum number of conversations to return. Defaults to 50."),
});

type ConversationListInput = z.infer<typeof conversationListSchema>;

interface ConversationSummary {
    id: string;
    title?: string;
    phase?: string;
    messageCount: number;
    createdAt?: number;
    lastActivity?: number;
}

interface ConversationListOutput {
    success: boolean;
    conversations: ConversationSummary[];
    total: number;
}

function summarizeConversation(conversation: Conversation): ConversationSummary {
    const firstEvent = conversation.history[0];
    const lastEvent = conversation.history[conversation.history.length - 1];

    return {
        id: conversation.id,
        title: conversation.title,
        phase: conversation.phase,
        messageCount: conversation.history.length,
        createdAt: firstEvent?.created_at,
        lastActivity: lastEvent?.created_at,
    };
}

async function executeConversationList(
    input: ConversationListInput,
    context: ExecutionContext
): Promise<ConversationListOutput> {
    const limit = input.limit ?? 50;

    logger.info("📋 Listing conversations", {
        limit,
        agent: context.agent.name,
    });

    const allConversations = context.conversationCoordinator.getAllConversations();

    // Sort by last activity (most recent first)
    const sorted = [...allConversations].sort((a, b) => {
        const aLast = a.history[a.history.length - 1]?.created_at ?? 0;
        const bLast = b.history[b.history.length - 1]?.created_at ?? 0;
        return bLast - aLast;
    });

    const limited = sorted.slice(0, limit);
    const summaries = limited.map(summarizeConversation);

    logger.info("✅ Conversations listed", {
        total: allConversations.length,
        returned: summaries.length,
        agent: context.agent.name,
    });

    return {
        success: true,
        conversations: summaries,
        total: allConversations.length,
    };
}

export function createConversationListTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "List all active conversations with summary information including ID, title, phase, message count, and timestamps. Results are sorted by most recent activity. Use this to discover available conversations before retrieving specific ones with conversation_get.",

        inputSchema: conversationListSchema,

        execute: async (input: ConversationListInput) => {
            return await executeConversationList(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ limit }: ConversationListInput) => {
            return limit
                ? `Listing up to ${limit} conversations`
                : "Listing conversations";
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
