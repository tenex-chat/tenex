import type { ToolExecutionContext } from "@/tools/types";
import { join } from "node:path";
import {
    ConversationCatalogService,
    type ConversationCatalogListEntry,
    type ConversationCatalogParticipant,
} from "@/conversations/ConversationCatalogService";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";
import { PREFIX_LENGTH } from "@/utils/nostr-entity-parser";
import { getPubkeyService } from "@/services/PubkeyService";
import { resolveAgentSlug } from "@/services/agents/AgentResolution";
import { parseNostrUser } from "@/utils/nostr-entity-parser";
import { type ProjectDTag, createProjectDTag } from "@/types/project-ids";

const conversationListSchema = z.object({
    projectId: z
        .string()
        .optional()
        .describe(
            "Project ID to list conversations from. Pass 'ALL' to list from all projects. " +
            "If not specified, lists conversations from the current project only."
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
    with: z
        .string()
        .optional()
        .describe(
            "Filter to conversations where this actor was active. " +
            "Accepts an agent slug (e.g., 'claude-code') or a hex pubkey."
        ),
});

type ConversationListInput = z.infer<typeof conversationListSchema>;

interface ConversationSummary {
    /** Exact stored conversation ID, reusable with conversation_get */
    id: string;
    projectId?: string;
    title?: string;
    /** Full summary (not truncated) */
    summary?: string;
    messageCount: number;
    createdAt?: number;
    lastActivity?: number;
    /** Names of participants in this conversation (resolved via stored identity or PubkeyService) */
    participants: string[];
    /** Exact stored IDs of delegations that occurred in this conversation */
    delegations: string[];
}

interface ConversationListOutput {
    success: boolean;
    conversations: ConversationSummary[];
    total: number;
}

function shortenPrincipalId(principalId: string): string {
    const terminalSegment = principalId.split(":").pop();
    if (terminalSegment?.trim()) {
        return terminalSegment.substring(0, PREFIX_LENGTH);
    }
    return principalId.substring(0, PREFIX_LENGTH);
}

function resolveParticipantName(participant: ConversationCatalogParticipant): string {
    if (participant.linkedPubkey) {
        return getPubkeyService().getNameSync(participant.linkedPubkey);
    }

    const displayName = participant.displayName?.trim();
    if (displayName) {
        return displayName;
    }

    const username = participant.username?.trim();
    if (username) {
        return username;
    }

    const principalId = participant.principalId;
    if (principalId) {
        return shortenPrincipalId(principalId);
    }

    return "Unknown";
}

function extractParticipantNames(conversation: ConversationCatalogListEntry): string[] {
    return conversation.participants.map((participant) => resolveParticipantName(participant));
}

function summarizeConversation(
    conversation: ConversationCatalogListEntry,
    projectId?: string
): ConversationSummary {
    const participantNames = extractParticipantNames(conversation);

    return {
        id: conversation.id,
        projectId,
        title: conversation.title,
        summary: conversation.summary,
        messageCount: conversation.messageCount,
        createdAt: conversation.createdAt,
        lastActivity: conversation.lastActivity || undefined,
        participants: participantNames,
        delegations: conversation.delegationIds,
    };
}

interface LoadedConversation {
    conversation: ConversationCatalogListEntry;
    projectId: ProjectDTag;
}

function loadConversationsForProject(
    projectId: ProjectDTag,
    filters: {
        fromTime?: number;
        toTime?: number;
        withPubkey?: string | null;
    }
): LoadedConversation[] {
    try {
        const catalog = ConversationCatalogService.getInstance(
            projectId,
            join(ConversationStore.getBasePath(), projectId)
        );

        return catalog.listConversations({
            fromTime: filters.fromTime,
            toTime: filters.toTime,
            participantPubkey: filters.withPubkey ?? undefined,
        }).map((conversation) => ({ conversation, projectId }));
    } catch (err) {
        logger.debug("Failed to load conversation catalog entries", { projectId, error: err });
        return [];
    }
}

function looksLikePubkey(value: string): boolean {
    const trimmed = value.trim();
    // 64-char hex pubkey
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        return true;
    }
    // npub or nprofile format
    if (trimmed.startsWith("npub1") || trimmed.startsWith("nprofile1")) {
        return true;
    }
    return false;
}

/**
 * Resolve the 'with' parameter to a pubkey.
 * Accepts agent slugs (single project only) or pubkeys (hex or npub format).
 *
 * @param withValue - The value to resolve
 * @param isAllProjects - Whether projectId="all" was specified
 * @throws Error if the value cannot be resolved to a pubkey
 */
function resolveWithParameter(withValue: string, isAllProjects: boolean): string {
    const trimmed = withValue.trim();

    // If it looks like a pubkey, try to parse it directly
    if (looksLikePubkey(trimmed)) {
        const parsedPubkey = parseNostrUser(trimmed);
        if (parsedPubkey) {
            return parsedPubkey;
        }
        throw new Error(
            `Failed to resolve 'with' parameter: "${withValue}". The value looks like a pubkey but could not be parsed. Please provide a valid hex pubkey.`
        );
    }

    // It looks like a slug - check if we're in all-projects mode
    if (isAllProjects) {
        throw new Error(
            `Agent slugs are not supported when projectId='all'. The slug "${withValue}" can only be resolved within the current project. Please provide a hex pubkey instead.`
        );
    }

    // Try to resolve as agent slug (single project only)
    const agentResult = resolveAgentSlug(trimmed);
    if (agentResult.pubkey) {
        return agentResult.pubkey;
    }

    // Slug resolution failed - provide helpful error with available slugs
    const availableSlugsMsg = agentResult.availableSlugs.length > 0
        ? ` Available agent slugs in this project: ${agentResult.availableSlugs.join(", ")}.`
        : "";

    throw new Error(
        `Failed to resolve 'with' parameter: "${withValue}". ` +
        `Could not find an agent with this slug or parse it as a pubkey.${availableSlugsMsg}`
    );
}

async function executeConversationList(
    input: ConversationListInput,
    context: ToolExecutionContext
): Promise<ConversationListOutput> {
    const limit = input.limit ?? 50;
    const { fromTime, toTime, projectId: requestedProjectId } = input;
    const withParam = input.with;

    const currentProjectId = ConversationStore.getProjectId();

    // Normalize projectId: case-insensitive "all" check, or cast user input to ProjectDTag
    const normalizedRequestedProjectId: "all" | ProjectDTag | undefined =
        requestedProjectId?.toLowerCase() === "all" ? "all" :
        requestedProjectId ? createProjectDTag(requestedProjectId) : undefined;

    // Default to current project if not specified (NOT all projects)
    const effectiveProjectId: "all" | ProjectDTag | null = normalizedRequestedProjectId ?? currentProjectId;

    // Determine if we're querying all projects
    const isAllProjects = effectiveProjectId === "all";

    // Resolve the 'with' parameter to a pubkey if provided
    // This will throw an error if resolution fails, preventing silent fallback to unfiltered results
    let withPubkey: string | null = null;
    if (withParam) {
        withPubkey = resolveWithParameter(withParam, isAllProjects);
    }

    logger.info("📋 Listing conversations", {
        limit,
        fromTime,
        toTime,
        projectId: effectiveProjectId,
        with: withParam,
        withPubkey: withPubkey ? withPubkey.substring(0, PREFIX_LENGTH) : undefined,
        agent: context.agent.name,
    });

    // Load conversations based on projectId parameter
    let allConversations: LoadedConversation[] = [];

    if (effectiveProjectId === "all") {
        // Only load from all projects when explicitly requested with "ALL"
        const projectIds = ConversationStore.listProjectIdsFromDisk();
        for (const pid of projectIds) {
            const projectConversations = loadConversationsForProject(pid, {
                fromTime,
                toTime,
                withPubkey,
            });
            allConversations.push(...projectConversations);
        }
    } else if (effectiveProjectId) {
        // Load from specific project (current project by default)
        allConversations = loadConversationsForProject(effectiveProjectId, {
            fromTime,
            toTime,
            withPubkey,
        });
    }

    // Sort by last activity (most recent first)
    const sorted = [...allConversations].sort((a, b) => {
        return (b.conversation.lastActivity ?? 0) - (a.conversation.lastActivity ?? 0);
    });

    const limited = sorted.slice(0, limit);
    const summaries = limited.map(({ conversation, projectId }) =>
        summarizeConversation(conversation, projectId)
    );

    logger.info("✅ Conversations listed", {
        total: allConversations.length,
        filtered: allConversations.length,
        returned: summaries.length,
        projectId: effectiveProjectId,
        with: withParam,
        agent: context.agent.name,
    });

    return {
        success: true,
        conversations: summaries,
        total: allConversations.length,
    };
}

export function createConversationListTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "List conversations for this project with summary information including the exact stored conversation ID, title, summary, participants, delegations, message count, and timestamps. Results are sorted by most recent activity. Supports optional date range filtering with fromTime/toTime (Unix timestamps in seconds). Use the 'with' parameter to filter to conversations where a specific actor was active. Use the returned id values directly with conversation_get.",

        inputSchema: conversationListSchema,

        execute: async (input: ConversationListInput) => {
            return await executeConversationList(input, context);
        },
    });

    return aiTool as AISdkTool;
}
