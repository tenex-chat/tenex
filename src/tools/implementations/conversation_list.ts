import type { ToolExecutionContext } from "@/tools/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { ConversationRecord } from "@/conversations/types";
import {
    getConversationRecordAuthorPrincipalId,
    getConversationRecordAuthorPubkey,
} from "@/conversations/record-author";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";
import { DISPLAY_PREFIX_LENGTH } from "@/utils/nostr-entity-parser";
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
        .describe("Maximum number of root conversations to return. Defaults to 50."),
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

interface ChildConversationSummary {
    /** Shortened event ID */
    id: string;
    title?: string;
    /** Recipient agent name */
    recipient?: string;
    /** Last activity as human-readable relative time */
    lastActive?: string;
    /** Nested child conversations */
    children: ChildConversationSummary[];
}

interface ConversationSummary {
    /** Shortened event ID (DISPLAY_PREFIX_LENGTH characters) */
    id: string;
    projectId?: string;
    title?: string;
    /** Full summary (not truncated) */
    summary?: string;
    /** Who started the conversation */
    sender?: string;
    /** Agent handling this conversation */
    recipient?: string;
    /** Last activity as human-readable relative time */
    lastActive?: string;
    /** Nested child conversations (delegations) */
    children: ChildConversationSummary[];
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
    return fullId.substring(0, DISPLAY_PREFIX_LENGTH);
}

function shortenPrincipalId(principalId: string): string {
    const terminalSegment = principalId.split(":").pop();
    if (terminalSegment?.trim()) {
        return terminalSegment.substring(0, DISPLAY_PREFIX_LENGTH);
    }
    return principalId.substring(0, DISPLAY_PREFIX_LENGTH);
}

function resolveParticipantName(message: ConversationRecord): string {
    const authorPubkey = getConversationRecordAuthorPubkey(message);
    if (authorPubkey) {
        return getPubkeyService().getNameSync(authorPubkey);
    }

    const displayName = message.senderPrincipal?.displayName?.trim();
    if (displayName) {
        return displayName;
    }

    const username = message.senderPrincipal?.username?.trim();
    if (username) {
        return username;
    }

    const principalId = getConversationRecordAuthorPrincipalId(message);
    if (principalId) {
        return shortenPrincipalId(principalId);
    }

    return "Unknown";
}

/**
 * Resolve a pubkey to a display name using the PubkeyService.
 */
function resolveNameFromPubkey(pubkey: string): string {
    return getPubkeyService().getNameSync(pubkey);
}

/**
 * Get sender name from the first message of a conversation.
 */
function extractSender(conversation: ConversationStore): string | undefined {
    const messages = conversation.getAllMessages();
    if (messages.length === 0) return undefined;
    return resolveParticipantName(messages[0]);
}

/**
 * Get recipient agent name from:
 * 1. delegationChain last entry (current agent) if present
 * 2. targetedPubkeys of first message
 */
function extractRecipient(conversation: ConversationStore): string | undefined {
    const metadata = conversation.metadata;
    const chain = metadata.delegationChain;

    if (chain && chain.length > 0) {
        const lastEntry = chain[chain.length - 1];
        return lastEntry.displayName;
    }

    const messages = conversation.getAllMessages();
    if (messages.length === 0) return undefined;

    const firstMessage = messages[0];
    const targeted = firstMessage.targetedPubkeys;
    if (targeted && targeted.length > 0) {
        return resolveNameFromPubkey(targeted[0]);
    }

    return undefined;
}

/**
 * Format a Unix timestamp as a relative time string like "3 minutes ago", "2 days ago".
 */
function formatRelativeTime(timestamp: number | undefined, nowSeconds: number): string | undefined {
    if (!timestamp) return undefined;
    const diffSeconds = nowSeconds - timestamp;
    if (diffSeconds < 0) return "just now";
    if (diffSeconds < 60) return `${diffSeconds} second${diffSeconds !== 1 ? "s" : ""} ago`;
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes !== 1 ? "s" : ""} ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths} month${diffMonths !== 1 ? "s" : ""} ago`;
    const diffYears = Math.floor(diffMonths / 12);
    return `${diffYears} year${diffYears !== 1 ? "s" : ""} ago`;
}

/**
 * Check if a conversation is a root conversation (not a delegation child).
 * A conversation is root if its delegationChain metadata is absent or empty.
 */
function isRootConversation(store: ConversationStore): boolean {
    const chain = store.metadata.delegationChain;
    return !chain || chain.length === 0;
}

/**
 * Get the direct parent conversation ID from a child conversation's delegationChain.
 * The parent is the second-to-last entry in the chain (last entry is the current conversation's agent).
 * Returns undefined if this is a root conversation or chain is too short.
 */
function getParentConversationId(store: ConversationStore): string | undefined {
    const chain = store.metadata.delegationChain;
    if (!chain || chain.length < 2) return undefined;
    return chain[chain.length - 2].conversationId;
}

function summarizeConversation(
    conversation: ConversationStore,
    projectId: string | undefined,
    children: ChildConversationSummary[],
    nowSeconds: number
): ConversationSummary {
    const messages = conversation.getAllMessages();
    const lastMessage = messages[messages.length - 1];
    const metadata = conversation.metadata;
    const lastActivity = lastMessage?.timestamp;

    return {
        id: shortenEventId(conversation.id),
        projectId,
        title: metadata.title ?? conversation.title,
        summary: metadata.summary,
        sender: extractSender(conversation),
        recipient: extractRecipient(conversation),
        lastActive: lastActivity ? formatRelativeTime(lastActivity, nowSeconds) : undefined,
        children,
    };
}

function summarizeChildConversation(
    conversation: ConversationStore,
    allConversations: Map<string, LoadedConversation>,
    nowSeconds: number
): ChildConversationSummary {
    const metadata = conversation.metadata;
    const messages = conversation.getAllMessages();
    const lastMessage = messages[messages.length - 1];
    const lastActivity = lastMessage?.timestamp;

    // Collect direct children of this conversation
    const directChildren = collectDirectChildren(conversation.id, allConversations, nowSeconds);

    return {
        id: shortenEventId(conversation.id),
        title: metadata.title ?? conversation.title,
        recipient: extractRecipient(conversation),
        lastActive: lastActivity ? formatRelativeTime(lastActivity, nowSeconds) : undefined,
        children: directChildren,
    };
}

/**
 * Collect and summarize direct children of a given conversation ID.
 */
function collectDirectChildren(
    parentId: string,
    allConversations: Map<string, LoadedConversation>,
    nowSeconds: number
): ChildConversationSummary[] {
    // First collect children with their last activity timestamps for sorting
    const childEntries: Array<{ loaded: LoadedConversation; lastActivity: number }> = [];

    for (const [, loaded] of allConversations) {
        const childParentId = getParentConversationId(loaded.store);
        if (childParentId === parentId) {
            const messages = loaded.store.getAllMessages();
            const lastMessage = messages[messages.length - 1];
            const lastActivity = lastMessage?.timestamp ?? 0;
            childEntries.push({ loaded, lastActivity });
        }
    }

    // Sort by last activity descending
    childEntries.sort((a, b) => b.lastActivity - a.lastActivity);

    // Now summarize in sorted order
    return childEntries.map(({ loaded }) =>
        summarizeChildConversation(loaded.store, allConversations, nowSeconds)
    );
}

/**
 * Compute the most recent activity time across a conversation and all its descendants.
 */
function computeSubtreeLastActivity(
    convId: string,
    allConversations: Map<string, LoadedConversation>,
    visited: Set<string> = new Set()
): number {
    if (visited.has(convId)) return 0;
    visited.add(convId);

    const loaded = allConversations.get(convId);
    if (!loaded) return 0;

    let maxTime = loaded.store.getLastActivityTime();

    // Find all direct children and recurse
    for (const [, child] of allConversations) {
        const childParentId = getParentConversationId(child.store);
        if (childParentId === convId) {
            const childTime = computeSubtreeLastActivity(child.store.id, allConversations, visited);
            if (childTime > maxTime) maxTime = childTime;
        }
    }

    return maxTime;
}

interface LoadedConversation {
    store: ConversationStore;
    projectId: ProjectDTag;
}

function loadConversationsForProject(
    projectId: ProjectDTag,
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
        if (getConversationRecordAuthorPubkey(message) === pubkey) {
            return true;
        }
    }
    return false;
}

/**
 * Check if a conversation subtree (root + all descendants) has a specific pubkey as participant.
 */
function subtreeHasParticipant(
    convId: string,
    allConversations: Map<string, LoadedConversation>,
    pubkey: string,
    visited: Set<string> = new Set()
): boolean {
    if (visited.has(convId)) return false;
    visited.add(convId);

    const loaded = allConversations.get(convId);
    if (!loaded) return false;

    if (conversationHasParticipant(loaded.store, pubkey)) return true;

    // Check children
    for (const [, child] of allConversations) {
        const childParentId = getParentConversationId(child.store);
        if (childParentId === convId) {
            if (subtreeHasParticipant(child.store.id, allConversations, pubkey, visited)) {
                return true;
            }
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

    logger.info("📋 Listing conversations (tree view)", {
        limit,
        fromTime,
        toTime,
        projectId: effectiveProjectId,
        with: withParam,
        withPubkey: withPubkey ? shortenEventId(withPubkey) : undefined,
        agent: context.agent.name,
    });

    // Load conversations based on projectId parameter
    let allLoadedConversations: LoadedConversation[] = [];

    if (effectiveProjectId === "all") {
        // Only load from all projects when explicitly requested with "ALL"
        const projectIds = ConversationStore.listProjectIdsFromDisk();
        for (const pid of projectIds) {
            const isCurrentProject = pid === currentProjectId;
            const projectConversations = loadConversationsForProject(pid, isCurrentProject);
            allLoadedConversations.push(...projectConversations);
        }
    } else if (effectiveProjectId) {
        // Load from specific project (current project by default)
        const isCurrentProject = effectiveProjectId === currentProjectId;
        allLoadedConversations = loadConversationsForProject(effectiveProjectId, isCurrentProject);
    }

    // Build a map of all conversations by full ID for tree traversal
    const conversationMap = new Map<string, LoadedConversation>();
    for (const loaded of allLoadedConversations) {
        conversationMap.set(loaded.store.id, loaded);
    }

    // Separate root conversations from children
    const rootConversations = allLoadedConversations.filter(({ store }) => isRootConversation(store));

    const nowSeconds = Math.floor(Date.now() / 1000);

    // Compute subtree last activity for each root
    const rootsWithSubtreeActivity = rootConversations.map((loaded) => ({
        loaded,
        subtreeLastActivity: computeSubtreeLastActivity(loaded.store.id, conversationMap),
    }));

    // Apply date range filter based on subtree activity
    let filteredRoots = rootsWithSubtreeActivity;
    if (fromTime !== undefined || toTime !== undefined) {
        filteredRoots = rootsWithSubtreeActivity.filter(({ subtreeLastActivity }) => {
            if (fromTime !== undefined && subtreeLastActivity < fromTime) return false;
            if (toTime !== undefined && subtreeLastActivity > toTime) return false;
            return true;
        });
    }

    // Apply 'with' filter: include root if the root itself or any descendant has the participant
    if (withPubkey) {
        filteredRoots = filteredRoots.filter(({ loaded }) =>
            subtreeHasParticipant(loaded.store.id, conversationMap, withPubkey)
        );
    }

    // Sort by subtree last activity (most recent first)
    const sortedRoots = [...filteredRoots].sort((a, b) =>
        b.subtreeLastActivity - a.subtreeLastActivity
    );

    // Apply limit to root count
    const limitedRoots = sortedRoots.slice(0, limit);

    // Build summaries with nested children
    const summaries = limitedRoots.map(({ loaded }) => {
        const { store, projectId } = loaded;
        const children = collectDirectChildren(store.id, conversationMap, nowSeconds);
        return summarizeConversation(store, projectId, children, nowSeconds);
    });

    logger.info("✅ Conversations listed (tree view)", {
        total: rootConversations.length,
        filtered: filteredRoots.length,
        returned: summaries.length,
        projectId: effectiveProjectId,
        with: withParam,
        agent: context.agent.name,
    });

    return {
        success: true,
        conversations: summaries,
        total: filteredRoots.length,
    };
}

export function createConversationListTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "List root conversations for this project as a hierarchical tree. Each root conversation shows " +
            "its full delegation chain as nested children. Results are sorted by most recent activity in the " +
            "entire subtree — a root conversation with a recently active delegation will appear near the top " +
            "even if the root itself is old. The 'limit' parameter controls the number of root conversations " +
            "returned. Supports optional date range filtering with fromTime/toTime (Unix timestamps in seconds). " +
            "Use the 'with' parameter to filter to conversations where a specific actor was active. " +
            "Use this to discover available conversations before retrieving specific ones with conversation_get.",

        inputSchema: conversationListSchema,

        execute: async (input: ConversationListInput) => {
            return await executeConversationList(input, context);
        },
    });

    return aiTool as AISdkTool;
}
