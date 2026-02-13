import type { ToolExecutionContext } from "@/tools/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";
import { PREFIX_LENGTH } from "@/utils/nostr-entity-parser";
import { getPubkeyService } from "@/services/PubkeyService";
import { resolveAgentSlug } from "@/services/agents/AgentResolution";
import { parseNostrUser } from "@/utils/nostr-entity-parser";

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
            "Accepts an agent slug (e.g., 'claude-code') or a pubkey (hex or npub format)."
        ),
});

type ConversationListInput = z.infer<typeof conversationListSchema>;

interface ConversationSummary {
    /** Shortened event ID (12 characters) */
    id: string;
    projectId?: string;
    title?: string;
    /** Full summary (not truncated) */
    summary?: string;
    messageCount: number;
    createdAt?: number;
    lastActivity?: number;
    /** Names of participants in this conversation (resolved via PubkeyService) */
    participants: string[];
    /** Shortened event IDs of delegations that occurred in this conversation */
    delegations: string[];
}

interface ConversationListOutput {
    success: boolean;
    conversations: ConversationSummary[];
    total: number;
}

/**
 * Shorten a full 64-char event ID to the standard prefix length
 */
function shortenEventId(fullId: string): string {
    return fullId.substring(0, PREFIX_LENGTH);
}

/**
 * Extract unique participant pubkeys from conversation messages (direct participants only)
 */
function extractParticipantPubkeys(conversation: ConversationStore): string[] {
    const messages = conversation.getAllMessages();
    const pubkeys = new Set<string>();

    for (const message of messages) {
        // Add the message author
        pubkeys.add(message.pubkey);
    }

    return Array.from(pubkeys);
}

/**
 * Extract delegation conversation IDs from delegation markers
 */
function extractDelegationIds(conversation: ConversationStore): string[] {
    const messages = conversation.getAllMessages();
    const delegationIds: string[] = [];

    for (const message of messages) {
        if (message.messageType === "delegation-marker" && message.delegationMarker) {
            delegationIds.push(message.delegationMarker.delegationConversationId);
        }
    }

    return delegationIds;
}

/**
 * Resolve pubkeys to display names using PubkeyService (sync version for performance)
 */
function resolveParticipantNames(pubkeys: string[]): string[] {
    const pubkeyService = getPubkeyService();
    return pubkeys.map(pk => pubkeyService.getNameSync(pk));
}

function summarizeConversation(conversation: ConversationStore, projectId?: string): ConversationSummary {
    const messages = conversation.getAllMessages();
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];
    const metadata = conversation.metadata;

    // Extract participants and delegations
    const participantPubkeys = extractParticipantPubkeys(conversation);
    const participantNames = resolveParticipantNames(participantPubkeys);
    const delegationIds = extractDelegationIds(conversation);

    return {
        id: shortenEventId(conversation.id),
        projectId,
        title: metadata.title ?? conversation.title,
        summary: metadata.summary,
        messageCount: messages.length,
        createdAt: firstMessage?.timestamp,
        lastActivity: lastMessage?.timestamp,
        participants: participantNames,
        delegations: delegationIds.map(shortenEventId),
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

/**
 * Check if a value looks like a pubkey (hex or npub format) rather than a slug.
 * This is used to determine if slug resolution should be attempted.
 */
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
            `Failed to resolve 'with' parameter: "${withValue}". ` +
            `The value looks like a pubkey but could not be parsed. ` +
            `Please provide a valid 64-character hex pubkey or npub format.`
        );
    }

    // It looks like a slug - check if we're in all-projects mode
    if (isAllProjects) {
        throw new Error(
            `Agent slugs are not supported when projectId='all'. ` +
            `The slug "${withValue}" can only be resolved within the current project. ` +
            `Please provide a pubkey (hex or npub format) instead.`
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

/**
 * Check if a conversation has a specific pubkey as a participant
 */
function conversationHasParticipant(conversation: ConversationStore, pubkey: string): boolean {
    const messages = conversation.getAllMessages();
    for (const message of messages) {
        if (message.pubkey === pubkey) {
            return true;
        }
    }
    return false;
}

async function executeConversationList(
    input: ConversationListInput,
    context: ToolExecutionContext
): Promise<ConversationListOutput> {
    const limit = input.limit ?? 50;
    const { fromTime, toTime, projectId: requestedProjectId } = input;
    const withParam = input.with;

    const currentProjectId = ConversationStore.getProjectId();

    // Normalize projectId: case-insensitive "all" check
    const normalizedRequestedProjectId = requestedProjectId?.toLowerCase() === "all" ? "all" : requestedProjectId;

    // Default to current project if not specified (NOT all projects)
    const effectiveProjectId = normalizedRequestedProjectId ?? currentProjectId;

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
        withPubkey: withPubkey ? shortenEventId(withPubkey) : undefined,
        agent: context.agent.name,
    });

    // Load conversations based on projectId parameter
    let allConversations: LoadedConversation[] = [];

    if (effectiveProjectId === "all") {
        // Only load from all projects when explicitly requested with "ALL"
        const projectIds = ConversationStore.listProjectIdsFromDisk();
        for (const pid of projectIds) {
            const isCurrentProject = pid === currentProjectId;
            const projectConversations = loadConversationsForProject(pid, isCurrentProject);
            allConversations.push(...projectConversations);
        }
    } else if (effectiveProjectId) {
        // Load from specific project (current project by default)
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

    // Filter by 'with' parameter if specified and resolved
    if (withPubkey) {
        filtered = filtered.filter(({ store }) => conversationHasParticipant(store, withPubkey));
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
        with: withParam,
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
            "List conversations for this project with summary information including ID, title, summary, participants, delegations, message count, and timestamps. Results are sorted by most recent activity. Supports optional date range filtering with fromTime/toTime (Unix timestamps in seconds). Use the 'with' parameter to filter to conversations where a specific actor was active. Use this to discover available conversations before retrieving specific ones with conversation_get.",

        inputSchema: conversationListSchema,

        execute: async (input: ConversationListInput) => {
            return await executeConversationList(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: (input: ConversationListInput) => {
            const { projectId, limit, fromTime, toTime } = input;
            const withParam = input.with;
            const parts: string[] = [];
            if (projectId?.toLowerCase() === "all") {
                parts.push("all projects");
            } else if (projectId) {
                parts.push(`project=${projectId}`);
            }
            if (withParam) parts.push(`with=${withParam}`);
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
