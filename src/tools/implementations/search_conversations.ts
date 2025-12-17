import type { ExecutionContext } from "@/agents/execution/types";
import type { Conversation } from "@/conversations/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const searchConversationsSchema = z.object({
    query: z.string().describe("Search query to match against conversation titles"),
    limit: z
        .number()
        .optional()
        .describe("Maximum number of results to return. Defaults to 20."),
});

type SearchConversationsInput = z.infer<typeof searchConversationsSchema>;

interface ConversationSummary {
    id: string;
    title?: string;
    phase?: string;
    messageCount: number;
    createdAt?: number;
    lastActivity?: number;
}

interface SearchConversationsOutput {
    success: boolean;
    conversations: ConversationSummary[];
    total: number;
    query: string;
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

async function executeSearchConversations(
    input: SearchConversationsInput,
    context: ExecutionContext
): Promise<SearchConversationsOutput> {
    const { query, limit = 20 } = input;

    logger.info("🔍 Searching conversations", {
        query,
        limit,
        agent: context.agent.name,
    });

    const results = await context.conversationCoordinator.searchConversations(query);

    const limited = results.slice(0, limit);
    const summaries = limited.map(summarizeConversation);

    logger.info("✅ Conversation search complete", {
        query,
        found: results.length,
        returned: summaries.length,
        agent: context.agent.name,
    });

    return {
        success: true,
        conversations: summaries,
        total: results.length,
        query,
    };
}

export function createSearchConversationsTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Search conversations by title. Returns matching conversations with summary information including ID, title, phase, message count, and timestamps.",

        inputSchema: searchConversationsSchema,

        execute: async (input: SearchConversationsInput) => {
            return await executeSearchConversations(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ query, limit }: SearchConversationsInput) => {
            return limit
                ? `Searching conversations for "${query}" (limit: ${limit})`
                : `Searching conversations for "${query}"`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
