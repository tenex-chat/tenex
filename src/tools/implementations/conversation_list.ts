import type { ToolExecutionContext } from "@/tools/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const conversationListSchema = z.object({
    projectId: z
        .string()
        .optional()
        .describe(
            "Project ID to list conversations from. Use 'all' to list from all projects. " +
            "If not specified, lists conversations from the current project."
        ),
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
    projectId?: string;
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
}

function summarizeConversation(conversation: ConversationStore, projectId?: string): ConversationSummary {
    const messages = conversation.getAllMessages();
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];
    const metadata = conversation.metadata;

    return {
        id: conversation.id,
        projectId,
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

interface LoadedConversation {
    store: ConversationStore;
    projectId: string;
}

function loadConversationsForProject(
    projectId: string,
    isCurrentProject: boolean
): LoadedConversation[] {
    const conversations: LoadedConversation[] = [];
    const conversationIds = isCurrentProject
        ? ConversationStore.listConversationIdsFromDisk()
        : ConversationStore.listConversationIdsFromDiskForProject(projectId);

    for (const id of conversationIds) {
        try {
            let store: ConversationStore;
            if (isCurrentProject) {
                // Use cached version for current project
                store = ConversationStore.getOrLoad(id);
            } else {
                // Load fresh for external projects
                store = new ConversationStore(ConversationStore.getBasePath());
                store.load(projectId, id);
            }
            conversations.push({ store, projectId });
        } catch (err) {
            logger.debug("Failed to load conversation", { id, projectId, error: err });
        }
    }
    return conversations;
}

async function executeConversationList(
    input: ConversationListInput,
    context: ToolExecutionContext
): Promise<ConversationListOutput> {
    const limit = input.limit ?? 50;
    const { fromTime, toTime, projectId: requestedProjectId } = input;

    const currentProjectId = ConversationStore.getProjectId();
    const effectiveProjectId = requestedProjectId ?? currentProjectId;

    logger.info("📋 Listing conversations", {
        limit,
        fromTime,
        toTime,
        projectId: effectiveProjectId,
        agent: context.agent.name,
    });

    // Load conversations based on projectId parameter
    let allConversations: LoadedConversation[] = [];

    if (effectiveProjectId === "all") {
        // Load from all projects
        const projectIds = ConversationStore.listProjectIdsFromDisk();
        for (const pid of projectIds) {
            const isCurrentProject = pid === currentProjectId;
            const projectConversations = loadConversationsForProject(pid, isCurrentProject);
            allConversations.push(...projectConversations);
        }
    } else {
        // Load from specific project
        const isCurrentProject = effectiveProjectId === currentProjectId;
        allConversations = loadConversationsForProject(effectiveProjectId, isCurrentProject);
    }

    // Filter by date range if specified
    let filtered = allConversations;
    if (fromTime !== undefined || toTime !== undefined) {
        filtered = allConversations.filter(({ store }) => {
            const lastActivity = store.getLastActivityTime();
            if (fromTime !== undefined && lastActivity < fromTime) return false;
            if (toTime !== undefined && lastActivity > toTime) return false;
            return true;
        });
    }

    // Sort by last activity (most recent first)
    const sorted = [...filtered].sort((a, b) => {
        return b.store.getLastActivityTime() - a.store.getLastActivityTime();
    });

    const limited = sorted.slice(0, limit);
    const summaries = limited.map(({ store, projectId }) => summarizeConversation(store, projectId));

    logger.info("✅ Conversations listed", {
        total: allConversations.length,
        filtered: filtered.length,
        returned: summaries.length,
        projectId: effectiveProjectId,
        agent: context.agent.name,
    });

    return {
        success: true,
        conversations: summaries,
        total: filtered.length,
    };
}

export function createConversationListTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "List conversations for this project with summary information including ID, title, summary, phase, status, message count, and timestamps. Results are sorted by most recent activity. Supports optional date range filtering with fromTime/toTime (Unix timestamps in seconds). Use this to discover available conversations before retrieving specific ones with conversation_get.",

        inputSchema: conversationListSchema,

        execute: async (input: ConversationListInput) => {
            return await executeConversationList(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ projectId, limit, fromTime, toTime }: ConversationListInput) => {
            const parts: string[] = [];
            if (projectId === "all") {
                parts.push("all projects");
            } else if (projectId) {
                parts.push(`project=${projectId}`);
            }
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
