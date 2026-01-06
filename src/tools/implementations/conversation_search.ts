import type { ToolExecutionContext } from "@/tools/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const conversationSearchSchema = z.object({
    query: z.string().describe("Search query to match against conversation titles"),
    limit: z
        .number()
        .optional()
        .describe("Maximum number of results to return. Defaults to 20."),
});

type ConversationSearchInput = z.infer<typeof conversationSearchSchema>;

interface ConversationSummary {
    id: string;
    title?: string;
    phase?: string;
    messageCount: number;
    createdAt?: number;
    lastActivity?: number;
}

interface ConversationSearchOutput {
    success: boolean;
    conversations: ConversationSummary[];
    total: number;
    query: string;
}

function summarizeConversation(conversation: ConversationStore): ConversationSummary {
    const messages = conversation.getAllMessages();
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];

    return {
        id: conversation.id,
        title: conversation.title,
        phase: conversation.phase,
        messageCount: messages.length,
        createdAt: firstMessage?.timestamp,
        lastActivity: lastMessage?.timestamp,
    };
}

async function executeConversationSearch(
    input: ConversationSearchInput,
    context: ToolExecutionContext
): Promise<ConversationSearchOutput> {
    const { query, limit = 20 } = input;

    logger.info("🔍 Searching conversations", {
        query,
        limit,
        agent: context.agent.name,
    });

    const results = ConversationStore.search(query);

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

export function createConversationSearchTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Search conversations by title. Returns matching conversations with summary information including ID, title, phase, message count, and timestamps.",

        inputSchema: conversationSearchSchema,

        execute: async (input: ConversationSearchInput) => {
            return await executeConversationSearch(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ query, limit }: ConversationSearchInput) => {
            return limit
                ? `Searching conversations for "${query}" (limit: ${limit})`
                : `Searching conversations for "${query}"`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
