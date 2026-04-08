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
    children: ChildConversationSummary[]
): ConversationSummary {
    const messages = conversation.getAllMessages();
    const lastMessage = messages[messages.length - 1];
    const metadata = conversation.metadata;
    const lastActivity = lastMessage?.timestamp;

    return {
        id: shortenConversationId(conversation.id),
        fullId: conversation.id,
        projectId,
        title: metadata.title ?? conversation.title,
        summary: metadata.summary,
        sender: extractSender(conversation),
        recipient: extractRecipient(conversation),
        lastActive: lastActivity ? formatTimeAgo(lastActivity * 1000) : undefined,
        children,
    };
}

function summarizeChildConversation(
    conversation: ConversationStore,
    allConversations: Map<string, LoadedConversation>
): ChildConversationSummary {
    const metadata = conversation.metadata;
    const messages = conversation.getAllMessages();
    const lastMessage = messages[messages.length - 1];
    const lastActivity = lastMessage?.timestamp;

    // Collect direct children of this conversation
    const directChildren = collectDirectChildren(conversation.id, allConversations);

    return {
        id: shortenConversationId(conversation.id),
        fullId: conversation.id,
        title: metadata.title ?? conversation.title,
        recipient: extractRecipient(conversation),
        lastActive: lastActivity ? formatTimeAgo(lastActivity * 1000) : undefined,
        children: directChildren,
    };
}

/**
 * Collect and summarize direct children of a given conversation ID.
 */
function collectDirectChildren(
    parentId: string,
    allConversations: Map<string, LoadedConversation>
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
        summarizeChildConversation(loaded.store, allConversations)
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

interface IndexedConversation {
    entry: ConversationCatalogListEntry;
    projectId: ProjectDTag;
}

interface ConversationGraph {
    conversationsById: Map<string, IndexedConversation>;
    childrenByParentId: Map<string, IndexedConversation[]>;
    rootConversationIds: string[];
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

function loadIndexedConversationsForProject(projectId: ProjectDTag): IndexedConversation[] {
    const metadataPath = join(ConversationStore.getBasePath(), projectId);
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

        const isCurrentProject = projectId === ConversationStore.getProjectId();
        return loadConversationsForProject(projectId, isCurrentProject).map(buildIndexedConversationFromStore);
    }
}

function buildIndexedConversationFromStore(conversation: LoadedConversation): IndexedConversation {
    const messages = conversation.store.getAllMessages();
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];
    const metadata = conversation.store.metadata as Record<string, unknown>;
    const participants = new Map<string, ConversationCatalogParticipant>();
    const delegationIds = new Set<string>();

    for (const message of messages) {
        const participantKey =
            getConversationRecordAuthorPrincipalId(message)
            ?? getConversationRecordAuthorPubkey(message);
        if (participantKey && !participants.has(participantKey)) {
            const linkedPubkey = getConversationRecordAuthorPubkey(message);
            const kind = message.senderPrincipal?.kind;
            participants.set(participantKey, {
                participantKey,
                linkedPubkey,
                principalId: getConversationRecordAuthorPrincipalId(message),
                transport: message.senderPrincipal?.transport,
                displayName:
                    typeof message.senderPrincipal?.displayName === "string"
                    && message.senderPrincipal.displayName.trim().length > 0
                        ? message.senderPrincipal.displayName
                        : undefined,
                username:
                    typeof message.senderPrincipal?.username === "string"
                    && message.senderPrincipal.username.trim().length > 0
                        ? message.senderPrincipal.username
                        : undefined,
                kind,
                isAgent: kind === "agent" || (!!linkedPubkey && ConversationStore.isAgentPubkey(linkedPubkey)),
            });
        }

        if (
            message.messageType === "delegation-marker"
            && message.delegationMarker?.delegationConversationId
        ) {
            delegationIds.add(message.delegationMarker.delegationConversationId);
        }
    }

    return {
        projectId: conversation.projectId,
        entry: {
            id: conversation.store.id,
            title:
                typeof metadata.title === "string" && metadata.title.trim().length > 0
                    ? metadata.title
                    : conversation.store.title,
            summary:
                typeof metadata.summary === "string" && metadata.summary.trim().length > 0
                    ? metadata.summary
                    : undefined,
            lastUserMessage:
                typeof metadata.lastUserMessage === "string" && metadata.lastUserMessage.trim().length > 0
                    ? metadata.lastUserMessage
                    : typeof metadata.last_user_message === "string" && metadata.last_user_message.trim().length > 0
                        ? metadata.last_user_message
                        : undefined,
            statusLabel:
                typeof metadata.statusLabel === "string" && metadata.statusLabel.trim().length > 0
                    ? metadata.statusLabel
                    : undefined,
            statusCurrentActivity:
                typeof metadata.statusCurrentActivity === "string" && metadata.statusCurrentActivity.trim().length > 0
                    ? metadata.statusCurrentActivity
                    : undefined,
            messageCount: messages.length,
            createdAt: firstMessage?.timestamp,
            lastActivity: lastMessage?.timestamp ?? 0,
            participants: Array.from(participants.values()),
            delegationIds: Array.from(delegationIds),
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

function resolveParticipantNameFromCatalog(participant: ConversationCatalogParticipant): string {
    if (participant.linkedPubkey) {
        return resolveNameFromPubkey(participant.linkedPubkey);
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

function extractSenderFromIndexedConversation(conversation: IndexedConversation): string | undefined {
    const sender = conversation.entry.participants[0];
    return sender ? resolveParticipantNameFromCatalog(sender) : undefined;
}

function extractRecipientFromIndexedConversation(conversation: IndexedConversation): string | undefined {
    const senderParticipantKey = conversation.entry.participants[0]?.participantKey;
    const recipient = conversation.entry.participants.find(
        (participant, index) =>
            participant.isAgent && (index > 0 || participant.participantKey !== senderParticipantKey)
    ) ?? conversation.entry.participants.find((participant) => participant.isAgent);

    return recipient ? resolveParticipantNameFromCatalog(recipient) : undefined;
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
    currentProjectId: ProjectDTag | null,
    storeCache: Map<string, ConversationStore | null>
): ChildConversationSummary {
    const store = loadConversationForSummary(conversation, currentProjectId, storeCache);
    const children = (graph.childrenByParentId.get(conversation.entry.id) ?? []).map((child) =>
        summarizeIndexedChildConversation(child, graph, currentProjectId, storeCache)
    );

    return {
        id: shortenConversationId(conversation.entry.id),
        fullId: conversation.entry.id,
        title: store?.metadata.title ?? store?.title ?? conversation.entry.title,
        recipient: store ? extractRecipient(store) : extractRecipientFromIndexedConversation(conversation),
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
    storeCache: Map<string, ConversationStore | null>
): ConversationSummary {
    const store = loadConversationForSummary(conversation, currentProjectId, storeCache);
    const children = (graph.childrenByParentId.get(conversation.entry.id) ?? []).map((child) =>
        summarizeIndexedChildConversation(child, graph, currentProjectId, storeCache)
    );

    return {
        id: shortenConversationId(conversation.entry.id),
        fullId: conversation.entry.id,
        projectId: conversation.projectId,
        title: store?.metadata.title ?? store?.title ?? conversation.entry.title,
        summary: store?.metadata.summary ?? conversation.entry.summary,
        sender: store ? extractSender(store) : extractSenderFromIndexedConversation(conversation),
        recipient: store ? extractRecipient(store) : extractRecipientFromIndexedConversation(conversation),
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
function resolveWithParameter(withValue: string, isAllProjects: boolean): WithFilter {
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
    const agentResult = resolveAgentSlug(trimmed);

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

/**
 * Check if a conversation has a specific pubkey as a participant
 */
function conversationHasParticipant(conversation: ConversationStore, filter: WithFilter): boolean {
    const messages = conversation.getAllMessages();
    for (const message of messages) {
        const authorPubkey = getConversationRecordAuthorPubkey(message);
        if (!authorPubkey) {
            continue;
        }

        const normalizedAuthor = authorPubkey.toLowerCase();
        if (
            (filter.kind === "exact" && normalizedAuthor === filter.pubkey.toLowerCase()) ||
            (filter.kind === "prefix" && normalizedAuthor.startsWith(filter.prefix))
        ) {
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
    filter: WithFilter,
    visited: Set<string> = new Set()
): boolean {
    if (visited.has(convId)) return false;
    visited.add(convId);

    const loaded = allConversations.get(convId);
    if (!loaded) return false;

    if (conversationHasParticipant(loaded.store, filter)) return true;

    // Check children
    for (const [, child] of allConversations) {
        const childParentId = getParentConversationId(child.store);
        if (childParentId === convId) {
            if (subtreeHasParticipant(child.store.id, allConversations, filter, visited)) {
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
    let withFilter: WithFilter | null = null;
    if (withParam) {
        withFilter = resolveWithParameter(withParam, isAllProjects);
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

    if (effectiveProjectId === "all") {
        const projectIds = ConversationStore.listProjectIdsFromDisk();
        const indexedConversations = projectIds.flatMap((projectId) =>
            loadIndexedConversationsForProject(projectId)
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

        let filteredRoots = rootsWithSubtreeActivity;
        if (fromTime !== undefined || toTime !== undefined) {
            filteredRoots = rootsWithSubtreeActivity.filter(({ subtreeLastActivity }) => {
                if (fromTime !== undefined && subtreeLastActivity < fromTime) return false;
                if (toTime !== undefined && subtreeLastActivity > toTime) return false;
                return true;
            });
        }

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

        const sortedRoots = [...filteredRoots].sort((a, b) =>
            b.subtreeLastActivity - a.subtreeLastActivity
        );
        const limitedRoots = sortedRoots.slice(0, limit);
        const storeCache = new Map<string, ConversationStore | null>();
        const summaries = limitedRoots.map(({ conversation }) =>
            summarizeIndexedConversation(conversation, graph, currentProjectId, storeCache)
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

    // Load conversations based on projectId parameter
    let allLoadedConversations: LoadedConversation[] = [];

    if (effectiveProjectId) {
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
    if (withFilter) {
        filteredRoots = filteredRoots.filter(({ loaded }) =>
            subtreeHasParticipant(loaded.store.id, conversationMap, withFilter)
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
        const children = collectDirectChildren(store.id, conversationMap);
        return summarizeConversation(store, projectId, children);
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
            "The filter accepts agent slugs, exact pubkeys, and short hex pubkey prefixes. " +
            "Use this to discover available conversations before retrieving specific ones with conversation_get.",

        inputSchema: conversationListSchema,

        execute: async (input: ConversationListInput) => {
            return await executeConversationList(input, context);
        },
    });

    return aiTool as AISdkTool;
}
