import type { ExecutionContext } from "@/agents/execution/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const conversationListSchema = z.object({
    limit: z
        .number()
        .optional()
        .describe("Maximum number of conversations to return. Defaults to 50."),
    fromTime: z
        .number()
        .optional()
        .describe("Only include conversations with activity on or after this Unix timestamp (seconds)."),
    toTime: z
        .number()
        .optional()
        .describe("Only include conversations with activity on or before this Unix timestamp (seconds)."),
});

type ConversationListInput = z.infer<typeof conversationListSchema>;

interface ConversationSummary {
    id: string;
    title?: string;
    summary?: string;
    phase?: string;
    statusLabel?: string;
    statusCurrentActivity?: string;
    messageCount: number;
    createdAt?: number;
    lastActivity?: number;
}

interface ConversationListOutput {
    success: boolean;
    conversations: ConversationSummary[];
    total: number;
    projectId?: string;
}

function summarizeConversation(conversation: ConversationStore): ConversationSummary {
    const messages = conversation.getAllMessages();
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];
    const metadata = conversation.metadata;

    return {
        id: conversation.id,
        title: metadata.title ?? conversation.title,
        summary: metadata.summary,
        phase: metadata.phase ?? conversation.phase,
        statusLabel: metadata.statusLabel,
        statusCurrentActivity: metadata.statusCurrentActivity,
        messageCount: messages.length,
        createdAt: firstMessage?.timestamp,
        lastActivity: lastMessage?.timestamp,
    };
}

async function executeConversationList(
    input: ConversationListInput,
    context: ExecutionContext
): Promise<ConversationListOutput> {
    const limit = input.limit ?? 50;
    const { fromTime, toTime } = input;

    const projectId = ConversationStore.getProjectId();

    logger.info("📋 Listing conversations", {
        limit,
        fromTime,
        toTime,
        projectId,
        agent: context.agent.name,
    });

    // Get all conversation IDs from disk for the current project
    const conversationIds = ConversationStore.listConversationIdsFromDisk();

    // Load all conversations (getOrLoad will use cached if available)
    const allConversations: ConversationStore[] = [];
    for (const id of conversationIds) {
        try {
            const store = ConversationStore.getOrLoad(id);
            allConversations.push(store);
        } catch (err) {
            // Skip conversations that fail to load
            logger.debug("Failed to load conversation", { id, error: err });
        }
    }

    // Filter by date range if specified
    let filtered = allConversations;
    if (fromTime !== undefined || toTime !== undefined) {
        filtered = allConversations.filter(conv => {
            const lastActivity = conv.getLastActivityTime();
            if (fromTime !== undefined && lastActivity < fromTime) return false;
            if (toTime !== undefined && lastActivity > toTime) return false;
            return true;
        });
    }

    // Sort by last activity (most recent first)
    const sorted = [...filtered].sort((a, b) => {
        return b.getLastActivityTime() - a.getLastActivityTime();
    });

    const limited = sorted.slice(0, limit);
    const summaries = limited.map(summarizeConversation);

    logger.info("✅ Conversations listed", {
        total: conversationIds.length,
        filtered: filtered.length,
        returned: summaries.length,
        projectId,
        agent: context.agent.name,
    });

    return {
        success: true,
        conversations: summaries,
        total: filtered.length,
        projectId: projectId ?? undefined,
    };
}

export function createConversationListTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "List conversations for this project with summary information including ID, title, summary, phase, status, message count, and timestamps. Results are sorted by most recent activity. Supports optional date range filtering with fromTime/toTime (Unix timestamps in seconds). Use this to discover available conversations before retrieving specific ones with conversation_get.",

        inputSchema: conversationListSchema,

        execute: async (input: ConversationListInput) => {
            return await executeConversationList(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ limit, fromTime, toTime }: ConversationListInput) => {
            const parts: string[] = [];
            if (limit) parts.push(`limit=${limit}`);
            if (fromTime) parts.push(`from=${new Date(fromTime * 1000).toISOString()}`);
            if (toTime) parts.push(`to=${new Date(toTime * 1000).toISOString()}`);

            return parts.length > 0
                ? `Listing conversations (${parts.join(", ")})`
                : "Listing conversations";
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
