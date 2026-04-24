/**
 * conversation_list tool - builds hierarchical tree view of conversations
 *
 * ARCHITECTURE NOTE:
 * This tool uses ConversationCatalogService to index conversations and compute
 * cross-project tree ordering without loading every transcript into memory.
 * It still loads ConversationStore on demand for returned conversations so the
 * response preserves sender/recipient formatting and metadata fallbacks.
 *
 * For ID formatting, it uses the centralized shortenConversationId() helper from
 * @/utils/conversation-id to maintain consistency across the codebase.
 *
 * For tools with simpler needs, use ConversationCatalogService + ConversationPresenter
 * for automatic ID formatting.
 */

import { join } from "node:path";
import type { ToolExecutionContext } from "@/tools/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { ConversationRecord } from "@/conversations/types";
import {
    ConversationCatalogService,
    type ConversationCatalogListEntry,
    type ConversationCatalogParticipant,
    buildConversationCatalogProjection,
} from "@/conversations/ConversationCatalogService";
import {
    getConversationRecordAuthorPrincipalId,
    getConversationRecordAuthorPubkey,
} from "@/conversations/record-author";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";
import { PUBKEY_DISPLAY_LENGTH, STORAGE_PREFIX_LENGTH } from "@/utils/nostr-entity-parser";
import { getPubkeyService } from "@/services/PubkeyService";
import { resolveAgentSlug } from "@/services/agents/AgentResolution";
import { parseNostrUser } from "@/utils/nostr-entity-parser";
import { shortenConversationId, shortenPubkey } from "@/utils/conversation-id";
import { type ProjectDTag, createProjectDTag } from "@/types/project-ids";
import { formatTimeAgo } from "@/lib/time";

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
            "Accepts an agent slug (e.g., 'claude-code'), a pubkey (hex or npub format), or a 6-10 char hex pubkey prefix."
        ),
});

type ConversationListInput = z.infer<typeof conversationListSchema>;

interface ChildConversationSummary {
    /** Shortened conversation ID (10 chars) for display */
    id: string;
    /** Full canonical conversation ID for lookups */
    fullId: string;
    title?: string;
    /** Recipient agent name */
    recipient?: string;
    /** Last activity as human-readable relative time */
    lastActive?: string;
    /** Nested child conversations */
    children: ChildConversationSummary[];
}

interface ConversationSummary {
    /** Shortened conversation ID (10 chars) for display */
    id: string;
    /** Full canonical conversation ID for lookups */
    fullId: string;
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

type WithFilter =
    | { kind: "exact"; pubkey: string }
    | { kind: "prefix"; prefix: string };


function isShortPubkeyPrefix(value: string): boolean {
    return /^[0-9a-fA-F]+$/.test(value) && value.length >= PUBKEY_DISPLAY_LENGTH && value.length <= STORAGE_PREFIX_LENGTH;
}

function resolveParticipantName(
    message: ConversationRecord,
    context: Pick<ToolExecutionContext, "projectContext">
): string {
    const authorPubkey = getConversationRecordAuthorPubkey(message);
    if (authorPubkey) {
        return getPubkeyService().getNameSync(authorPubkey, {
            projectContext: context.projectContext,
        });
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
        // Extract terminal segment from principal ID (e.g., "tg:user:12345" -> "12345")
        const terminalSegment = principalId.split(":").pop();
        if (terminalSegment?.trim()) {
            return shortenPubkey(terminalSegment);
        }
        return shortenPubkey(principalId);
    }

    return "Unknown";
}

/**
 * Resolve a pubkey to a display name using the PubkeyService.
 */
function resolveNameFromPubkey(
    pubkey: string,
    context: Pick<ToolExecutionContext, "projectContext">
): string {
    return getPubkeyService().getNameSync(pubkey, {
        projectContext: context.projectContext,
    });
}

/**
 * Get sender name from the first message of a conversation.
 */
function extractSender(
    conversation: ConversationStore,
    context: Pick<ToolExecutionContext, "projectContext">
): string | undefined {
    const messages = conversation.getAllMessages();
    if (messages.length === 0) return undefined;
    return resolveParticipantName(messages[0], context);
}

/**
 * Get recipient agent name from:
 * 1. delegationChain last entry (current agent) if present
 * 2. targetedPubkeys of first message
 */
function extractRecipient(
    conversation: ConversationStore,
    context: Pick<ToolExecutionContext, "projectContext">
): string | undefined {
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
        return resolveNameFromPubkey(targeted[0], context);
    }

    return undefined;
}


interface IndexedConversation {
    entry: ConversationCatalogListEntry;
    projectId: ProjectDTag;
}

interface ConversationGraph {
    conversationsById: Map<string, IndexedConversation>;
    childrenByParentId: Map<string, IndexedConversation[]>;
    rootConversationIds: string[];
}

function loadIndexedConversationsFromTranscriptScan(
    projectId: ProjectDTag,
    currentProjectId: ProjectDTag | null
): IndexedConversation[] {
    const conversations: IndexedConversation[] = [];
    const isCurrentProject = projectId === currentProjectId;
    const conversationIds = isCurrentProject
        ? ConversationStore.listConversationIdsFromDisk()
        : ConversationStore.listConversationIdsFromDiskForProject(projectId);

    for (const id of conversationIds) {
        try {
            let store: ConversationStore;
            if (isCurrentProject) {
                store = ConversationStore.getOrLoad(id);
            } else {
                store = new ConversationStore(ConversationStore.getBasePath());
                store.load(projectId, id);
            }
            conversations.push(buildIndexedConversationFromStore(store, projectId));
        } catch (err) {
            logger.debug("Failed to load conversation", { id, projectId, error: err });
        }
    }
    return conversations;
}

function loadIndexedConversationsForProject(
    projectId: ProjectDTag,
    currentProjectId: ProjectDTag | null
): IndexedConversation[] {
    const metadataPath = join(ConversationStore.getBasePath(), projectId);
    const shouldCloseCatalog = projectId !== currentProjectId;
    try {
        const catalog = ConversationCatalogService.getInstance(projectId, metadataPath);

        return catalog.listConversations({}).map((entry) => ({
            entry,
            projectId,
        }));
    } catch (error) {
        logger.warn("Failed to load catalog-backed conversations; falling back to transcript scan", {
            projectId,
            error,
        });

        return loadIndexedConversationsFromTranscriptScan(projectId, currentProjectId);
    } finally {
        if (shouldCloseCatalog) {
            ConversationCatalogService.closeProject(projectId, metadataPath);
        }
    }
}

function buildIndexedConversationFromStore(
    store: ConversationStore,
    projectId: ProjectDTag
): IndexedConversation {
    const projection = buildConversationCatalogProjection(
        store.metadata as Record<string, unknown> | undefined,
        store.getAllMessages(),
        ConversationStore.agentPubkeys
    );

    return {
        projectId,
        entry: {
            id: store.id,
            ...projection,
            lastActivity: projection.lastActivity ?? 0,
        },
    };
}

function buildConversationGraph(conversations: IndexedConversation[]): ConversationGraph {
    const conversationsById = new Map<string, IndexedConversation>();
    for (const conversation of conversations) {
        conversationsById.set(conversation.entry.id, conversation);
    }

    const childrenByParentId = new Map<string, IndexedConversation[]>();
    const parentByChildId = new Map<string, string>();

    for (const conversation of conversations) {
        for (const childId of conversation.entry.delegationIds) {
            const child = conversationsById.get(childId);
            if (!child) {
                continue;
            }

            const existingParentId = parentByChildId.get(childId);
            if (existingParentId && existingParentId !== conversation.entry.id) {
                logger.debug("Conversation referenced by multiple parents in catalog", {
                    conversationId: childId,
                    existingParentId,
                    ignoredParentId: conversation.entry.id,
                });
                continue;
            }

            parentByChildId.set(childId, conversation.entry.id);

            const children = childrenByParentId.get(conversation.entry.id) ?? [];
            children.push(child);
            childrenByParentId.set(conversation.entry.id, children);
        }
    }

    for (const children of childrenByParentId.values()) {
        children.sort((a, b) => b.entry.lastActivity - a.entry.lastActivity);
    }

    const rootConversationIds = conversations
        .map((conversation) => conversation.entry.id)
        .filter((conversationId) => !parentByChildId.has(conversationId));
    // Orphaned delegated conversations are promoted to roots when their parent is
    // missing from the visible dataset. That keeps the tree connected and listable
    // instead of silently dropping reachable conversations.

    return {
        conversationsById,
        childrenByParentId,
        rootConversationIds,
    };
}

function computeIndexedSubtreeLastActivity(
    conversationId: string,
    graph: ConversationGraph,
    memoizedSubtreeTimes: Map<string, number>,
    visited: Set<string> = new Set()
): number {
    const memoized = memoizedSubtreeTimes.get(conversationId);
    if (memoized !== undefined) {
        return memoized;
    }

    if (visited.has(conversationId)) {
        return 0;
    }
    visited.add(conversationId);

    const conversation = graph.conversationsById.get(conversationId);
    if (!conversation) {
        return 0;
    }

    let maxTime = conversation.entry.lastActivity;
    const children = graph.childrenByParentId.get(conversationId) ?? [];
    for (const child of children) {
        const childTime = computeIndexedSubtreeLastActivity(
            child.entry.id,
            graph,
            memoizedSubtreeTimes,
            visited
        );
        if (childTime > maxTime) {
            maxTime = childTime;
        }
    }

    visited.delete(conversationId);
    memoizedSubtreeTimes.set(conversationId, maxTime);
    return maxTime;
}

function indexedConversationHasParticipant(conversation: IndexedConversation, filter: WithFilter): boolean {
    for (const participant of conversation.entry.participants) {
        const participantPubkey =
            participant.linkedPubkey
            ?? (/^[0-9a-fA-F]{64}$/.test(participant.participantKey) ? participant.participantKey : undefined);
        if (!participantPubkey) {
            continue;
        }

        const normalizedParticipant = participantPubkey.toLowerCase();
        if (
            (filter.kind === "exact" && normalizedParticipant === filter.pubkey.toLowerCase())
            || (filter.kind === "prefix" && normalizedParticipant.startsWith(filter.prefix))
        ) {
            return true;
        }
    }

    return false;
}

function indexedSubtreeHasParticipant(
    conversationId: string,
    graph: ConversationGraph,
    filter: WithFilter,
    memoizedMatches: Map<string, boolean>,
    visited: Set<string> = new Set()
): boolean {
    const memoized = memoizedMatches.get(conversationId);
    if (memoized !== undefined) {
        return memoized;
    }

    if (visited.has(conversationId)) {
        return false;
    }
    visited.add(conversationId);

    const conversation = graph.conversationsById.get(conversationId);
    if (!conversation) {
        return false;
    }

    if (indexedConversationHasParticipant(conversation, filter)) {
        memoizedMatches.set(conversationId, true);
        visited.delete(conversationId);
        return true;
    }

    const children = graph.childrenByParentId.get(conversationId) ?? [];
    for (const child of children) {
        if (indexedSubtreeHasParticipant(child.entry.id, graph, filter, memoizedMatches, visited)) {
            memoizedMatches.set(conversationId, true);
            visited.delete(conversationId);
            return true;
        }
    }

    memoizedMatches.set(conversationId, false);
    visited.delete(conversationId);
    return false;
}

function resolveParticipantNameFromCatalog(
    participant: ConversationCatalogParticipant,
    context: Pick<ToolExecutionContext, "projectContext">
): string {
    if (participant.linkedPubkey) {
        return resolveNameFromPubkey(participant.linkedPubkey, context);
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
        const terminalSegment = principalId.split(":").pop();
        if (terminalSegment?.trim()) {
            return shortenPubkey(terminalSegment);
        }
        return shortenPubkey(principalId);
    }

    return "Unknown";
}

function extractSenderFromIndexedConversation(
    conversation: IndexedConversation,
    context: Pick<ToolExecutionContext, "projectContext">
): string | undefined {
    const sender = conversation.entry.participants[0];
    return sender ? resolveParticipantNameFromCatalog(sender, context) : undefined;
}

function extractRecipientFromIndexedConversation(
    conversation: IndexedConversation,
    context: Pick<ToolExecutionContext, "projectContext">
): string | undefined {
    const senderParticipantKey = conversation.entry.participants[0]?.participantKey;
    const recipient = conversation.entry.participants.find(
        (participant, index) =>
            participant.isAgent && (index > 0 || participant.participantKey !== senderParticipantKey)
    ) ?? conversation.entry.participants.find((participant) => participant.isAgent);

    return recipient ? resolveParticipantNameFromCatalog(recipient, context) : undefined;
}

function loadConversationForSummary(
    conversation: IndexedConversation,
    currentProjectId: ProjectDTag | null,
    storeCache: Map<string, ConversationStore | null>
): ConversationStore | null {
    const cacheKey = `${conversation.projectId}:${conversation.entry.id}`;
    const cachedStore = storeCache.get(cacheKey);
    if (cachedStore !== undefined) {
        return cachedStore;
    }

    try {
        let store: ConversationStore;
        if (conversation.projectId === currentProjectId) {
            store = ConversationStore.getOrLoad(conversation.entry.id);
        } else {
            store = new ConversationStore(ConversationStore.getBasePath());
            store.load(conversation.projectId, conversation.entry.id);
        }

        storeCache.set(cacheKey, store);
        return store;
    } catch (error) {
        logger.debug("Failed to load conversation for summary", {
            id: conversation.entry.id,
            projectId: conversation.projectId,
            error,
        });
        storeCache.set(cacheKey, null);
        return null;
    }
}

function summarizeIndexedChildConversation(
    conversation: IndexedConversation,
    graph: ConversationGraph,
    context: Pick<ToolExecutionContext, "projectContext">
): ChildConversationSummary {
    const children = (graph.childrenByParentId.get(conversation.entry.id) ?? []).map((child) =>
        summarizeIndexedChildConversation(child, graph, context)
    );

    return {
        id: shortenConversationId(conversation.entry.id),
        fullId: conversation.entry.id,
        title: conversation.entry.title,
        recipient: extractRecipientFromIndexedConversation(conversation, context),
        lastActive: conversation.entry.lastActivity
            ? formatTimeAgo(conversation.entry.lastActivity * 1000)
            : undefined,
        children,
    };
}

function summarizeIndexedConversation(
    conversation: IndexedConversation,
    graph: ConversationGraph,
    currentProjectId: ProjectDTag | null,
    storeCache: Map<string, ConversationStore | null>,
    context: Pick<ToolExecutionContext, "projectContext">
): ConversationSummary {
    const store = loadConversationForSummary(conversation, currentProjectId, storeCache);
    const children = (graph.childrenByParentId.get(conversation.entry.id) ?? []).map((child) =>
        summarizeIndexedChildConversation(child, graph, context)
    );

    return {
        id: shortenConversationId(conversation.entry.id),
        fullId: conversation.entry.id,
        projectId: conversation.projectId,
        title: store?.metadata.title ?? store?.title ?? conversation.entry.title,
        summary: store?.metadata.summary ?? conversation.entry.summary,
        sender: store ? extractSender(store, context) : extractSenderFromIndexedConversation(conversation, context),
        recipient: store ? extractRecipient(store, context) : extractRecipientFromIndexedConversation(conversation, context),
        lastActive: conversation.entry.lastActivity
            ? formatTimeAgo(conversation.entry.lastActivity * 1000)
            : undefined,
        children,
    };
}

/**
 * Resolve the 'with' parameter to a pubkey.
 * Accepts agent slugs (single project only), exact pubkeys (hex or npub format),
 * or short hex pubkey prefixes.
 *
 * @param withValue - The value to resolve
 * @param isAllProjects - Whether projectId="all" was specified
 * @throws Error if the value cannot be resolved to a pubkey
 */
function resolveWithParameter(
    withValue: string,
    isAllProjects: boolean,
    context: Pick<ToolExecutionContext, "projectContext">
): WithFilter {
    const trimmed = withValue.trim();

    const parsedPubkey = parseNostrUser(trimmed);
    if (parsedPubkey) {
        return { kind: "exact", pubkey: parsedPubkey };
    }

    const normalized = trimmed.startsWith("nostr:") ? trimmed.slice(6) : trimmed;
    if (isShortPubkeyPrefix(normalized)) {
        return { kind: "prefix", prefix: normalized.toLowerCase() };
    }

    if (
        /^[0-9a-fA-F]{64}$/.test(normalized) ||
        normalized.startsWith("npub1") ||
        normalized.startsWith("nprofile1")
    ) {
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
            `Please provide a pubkey (hex, short hex prefix, or npub format) instead.`
        );
    }

    // Try to resolve as agent slug (single project only)
    const agentResult = resolveAgentSlug(trimmed, context.projectContext);

    if (agentResult.pubkey) {
        return { kind: "exact", pubkey: agentResult.pubkey };
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
    let withFilter: WithFilter | null = null;
    if (withParam) {
        withFilter = resolveWithParameter(withParam, isAllProjects, context);
    }

    logger.info("📋 Listing conversations (tree view)", {
        limit,
        fromTime,
        toTime,
        projectId: effectiveProjectId,
        with: withParam,
        withPubkey: withFilter
            ? withFilter.kind === "exact"
                ? shortenPubkey(withFilter.pubkey)
                : `${withFilter.prefix}*`
            : undefined,
        agent: context.agent.name,
    });

    const projectIds = effectiveProjectId === "all"
        ? ConversationStore.listProjectIdsFromDisk()
        : effectiveProjectId
            ? [effectiveProjectId]
            : [];
    const indexedConversations = projectIds.flatMap((projectId) =>
        loadIndexedConversationsForProject(projectId, currentProjectId)
    );
    const graph = buildConversationGraph(indexedConversations);
    const memoizedSubtreeTimes = new Map<string, number>();

    const rootsWithSubtreeActivity = graph.rootConversationIds.map((conversationId) => ({
        conversation: graph.conversationsById.get(conversationId)!,
        subtreeLastActivity: computeIndexedSubtreeLastActivity(
            conversationId,
            graph,
            memoizedSubtreeTimes
        ),
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
    if (withFilter) {
        const memoizedMatches = new Map<string, boolean>();
        filteredRoots = filteredRoots.filter(({ conversation }) =>
            indexedSubtreeHasParticipant(
                conversation.entry.id,
                graph,
                withFilter,
                memoizedMatches
            )
        );
    }

    // Sort by subtree last activity (most recent first)
    const sortedRoots = [...filteredRoots].sort((a, b) =>
        b.subtreeLastActivity - a.subtreeLastActivity
    );

    // Apply limit to root count
    const limitedRoots = sortedRoots.slice(0, limit);

    // Build summaries with nested children
    const storeCache = new Map<string, ConversationStore | null>();
    const summaries = limitedRoots.map(({ conversation }) =>
        summarizeIndexedConversation(conversation, graph, currentProjectId, storeCache, context)
    );

    logger.info("✅ Conversations listed (tree view)", {
        total: graph.rootConversationIds.length,
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
            "The filter accepts agent slugs, exact pubkeys, and short hex pubkey prefixes. " +
            "Use this to discover available conversations before retrieving specific ones with conversation_get.",

        inputSchema: conversationListSchema,

        execute: async (input: ConversationListInput) => {
            return await executeConversationList(input, context);
        },
    });

    return aiTool as AISdkTool;
}
