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
            "Accepts an agent slug (e.g., 'claude-code') or a pubkey (hex or npub format)."
        ),
    participants: z
        .array(z.string())
        .optional()
        .describe(
            "Filter to conversations where ANY of these actors were active. Accepts agent slugs, pubkeys (hex/npub/nprofile), or shortened hex pubkeys (min 18 chars). OR semantics: matches if any participant is found."
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

function shortenPrincipalId(principalId: string): string {
    const terminalSegment = principalId.split(":").pop();
    if (terminalSegment?.trim()) {
        return terminalSegment.substring(0, PREFIX_LENGTH);
    }
    return principalId.substring(0, PREFIX_LENGTH);
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

function extractParticipantNames(conversation: ConversationStore): string[] {
    const participants = new Map<string, string>();

    for (const message of conversation.getAllMessages()) {
        const participantKey =
            getConversationRecordAuthorPrincipalId(message)
            ?? getConversationRecordAuthorPubkey(message);
        if (!participantKey || participants.has(participantKey)) {
            continue;
        }

        participants.set(participantKey, resolveParticipantName(message));
    }

    return Array.from(participants.values());
}

function summarizeConversation(conversation: ConversationStore, projectId?: string): ConversationSummary {
    const messages = conversation.getAllMessages();
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];
    const metadata = conversation.metadata;

    // Extract participants and delegations
    const participantNames = extractParticipantNames(conversation);
    const delegationIds = extractDelegationIds(conversation);

    return {
        id: conversation.id,
        projectId,
        title: metadata.title ?? conversation.title,
        summary: metadata.summary,
        messageCount: messages.length,
        createdAt: firstMessage?.timestamp,
        lastActivity: lastMessage?.timestamp,
        participants: participantNames,
        delegations: delegationIds,
    };
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
    // Strip nostr: prefix before classifying
    const cleaned = trimmed.startsWith("nostr:") ? trimmed.substring(6) : trimmed;
    // 64-char hex pubkey
    if (/^[0-9a-fA-F]{64}$/.test(cleaned)) {
        return true;
    }
    // npub or nprofile format (with or without nostr: prefix)
    if (cleaned.startsWith("npub1") || cleaned.startsWith("nprofile1")) {
        return true;
    }
    return false;
}

/**
 * Check if a value looks like a shortened hex pubkey (hex prefix between PREFIX_LENGTH and 63 chars).
 * Checked after looksLikePubkey() returns false (so 64-char hex is already handled).
 */
function looksLikeShortenedPubkey(value: string): boolean {
    const trimmed = value.trim().toLowerCase();
    return new RegExp(`^[0-9a-f]{${PREFIX_LENGTH},63}$`).test(trimmed);
}

/**
 * Check if any entries in the array look like shortened hex pubkeys.
 * Used to decide between fast path (upfront resolution) and slow path (post-load resolution).
 */
function hasShortenedHexEntries(entries: string[]): boolean {
    return entries.some(e => looksLikeShortenedPubkey(e));
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
            `Failed to resolve 'with' parameter: "${withValue}". The value looks like a pubkey but could not be parsed. Please provide a valid 64-character hex pubkey or npub format.`
        );
    }

    // It looks like a slug - check if we're in all-projects mode
    if (isAllProjects) {
        throw new Error(
            `Agent slugs are not supported when projectId='all'. The slug "${withValue}" can only be resolved within the current project. Please provide a pubkey (hex or npub format) instead.`
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
 * Resolve a single entry from the participants array to a pubkey.
 *
 * @param entry - The entry string to resolve
 * @param index - Index in the participants array (for error messages)
 * @param isAllProjects - Whether projectId="all" was specified
 * @param knownPubkeys - Array of known pubkeys for shortened hex prefix matching (null on fast path)
 * @throws Error if the entry cannot be resolved
 */
function resolveParticipantEntry(
    entry: string,
    index: number,
    isAllProjects: boolean,
    knownPubkeys: string[] | null
): string {
    const value = entry.trim();

    if (!value) {
        throw new Error(`participants[${index}]: empty or whitespace-only entry is not valid.`);
    }

    if (looksLikePubkey(value)) {
        const parsed = parseNostrUser(value);
        if (parsed) {
            return parsed;
        }
        throw new Error(
            `participants[${index}]: "${entry}" looks like a pubkey but could not be parsed. ` +
            "Please provide a valid 64-character hex pubkey or npub/nprofile format."
        );
    }

    if (looksLikeShortenedPubkey(value)) {
        if (knownPubkeys === null) {
            // This should never happen — caller ensures knownPubkeys is set on slow path
            throw new Error(`participants[${index}]: internal error — shortened hex requires known pubkeys.`);
        }
        const prefix = value.toLowerCase();
        const matches = knownPubkeys.filter(pk => pk.startsWith(prefix));
        if (matches.length === 1) {
            return matches[0];
        }
        if (matches.length === 0) {
            throw new Error(
                `participants[${index}]: no known pubkey matches prefix '${value}'. Provide a longer prefix or full pubkey.`
            );
        }
        throw new Error(
            `participants[${index}]: prefix '${value}' is ambiguous — matches ${matches.length} pubkeys. Provide a longer prefix (at least ${PREFIX_LENGTH} hex chars recommended).`
        );
    }

    // Assume slug
    if (isAllProjects) {
        throw new Error(
            `participants[${index}]: agent slug '${value}' cannot be used with projectId=ALL. Use a full pubkey or npub instead.`
        );
    }

    const result = resolveAgentSlug(value);
    if (result.pubkey) {
        return result.pubkey;
    }

    throw new Error(
        `participants[${index}]: failed to resolve '${value}'. Not a known agent slug (available: ${result.availableSlugs.join(", ")}), pubkey, or npub/nprofile.`
    );
}

/**
 * Resolve all entries in the participants array into a Set of pubkeys.
 * Shortened hex entries require knownPubkeys to be provided (slow path).
 */
function resolveParticipantsSet(
    entries: string[],
    isAllProjects: boolean,
    knownPubkeys: string[] | null
): Set<string> {
    const result = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
        result.add(resolveParticipantEntry(entries[i], i, isAllProjects, knownPubkeys));
    }
    return result;
}

/**
 * Check if a conversation has any of the given pubkeys as a participant.
 * Uses Set.has() for O(1) lookup per message. Early exit on first match.
 */
function conversationHasAnyParticipant(
    conversation: ConversationStore,
    pubkeys: Set<string>
): boolean {
    for (const message of conversation.getAllMessages()) {
        const authorPubkey = getConversationRecordAuthorPubkey(message);
        if (authorPubkey && pubkeys.has(authorPubkey)) {
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
    const participantsParam = input.participants;

    const currentProjectId = ConversationStore.getProjectId();

    // Normalize projectId: case-insensitive "all" check, or cast user input to ProjectDTag
    const normalizedRequestedProjectId: "all" | ProjectDTag | undefined =
        requestedProjectId?.toLowerCase() === "all" ? "all" :
        requestedProjectId ? createProjectDTag(requestedProjectId) : undefined;

    // Default to current project if not specified (NOT all projects)
    const effectiveProjectId: "all" | ProjectDTag | null = normalizedRequestedProjectId ?? currentProjectId;

    // Determine if we're querying all projects
    const isAllProjects = effectiveProjectId === "all";

    // Determine if any participant filtering is needed
    const hasWithParam = !!withParam;
    const hasParticipantsParam = !!(participantsParam?.length);

    // Narrowed non-optional references (safe because hasWithParam/hasParticipantsParam guard them)
    const narrowedWith: string | null = hasWithParam ? (withParam ?? null) : null;
    const narrowedParticipants: string[] | null = hasParticipantsParam ? (participantsParam ?? null) : null;

    // Determine which path to take for participants resolution
    const needsParticipantFilter = hasWithParam || hasParticipantsParam;
    const usesSlowPath = narrowedParticipants !== null && hasShortenedHexEntries(narrowedParticipants);

    // Fast path: resolve all participants upfront (no shortened hex entries)
    let fastPathPubkeys: Set<string> | null = null;
    if (needsParticipantFilter && !usesSlowPath) {
        const pubkeys = new Set<string>();
        if (narrowedWith !== null) {
            pubkeys.add(resolveWithParameter(narrowedWith, isAllProjects));
        }
        if (narrowedParticipants !== null) {
            for (const pk of resolveParticipantsSet(narrowedParticipants, isAllProjects, null)) {
                pubkeys.add(pk);
            }
        }
        fastPathPubkeys = pubkeys;
    }

    logger.info("📋 Listing conversations", {
        limit,
        fromTime,
        toTime,
        projectId: effectiveProjectId,
        with: withParam,
        participants: participantsParam?.length,
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

    // Filter by participant(s) if needed
    if (needsParticipantFilter) {
        if (!usesSlowPath) {
            // Fast path: use pre-resolved pubkeys (fastPathPubkeys is set when !usesSlowPath && needsParticipantFilter)
            const pubkeySet = fastPathPubkeys ?? new Set<string>();
            filtered = filtered.filter(({ store }) => conversationHasAnyParticipant(store, pubkeySet));
        } else {
            // Slow path: shortened hex present — collect known pubkeys first, then resolve
            // Resolve non-shortened entries upfront
            const resolvedPubkeys = new Set<string>();

            if (narrowedWith !== null) {
                resolvedPubkeys.add(resolveWithParameter(narrowedWith, isAllProjects));
            }

            // narrowedParticipants is non-null here because usesSlowPath requires it
            const slowPathParticipants = narrowedParticipants ?? [];

            // Separate shortened and non-shortened entries
            const nonShortenedEntries: Array<{ entry: string; index: number }> = [];
            const shortenedEntries: Array<{ entry: string; index: number }> = [];
            for (let i = 0; i < slowPathParticipants.length; i++) {
                const entry = slowPathParticipants[i];
                const trimmed = entry.trim();
                if (!trimmed) {
                    throw new Error(`participants[${i}]: empty or whitespace-only entry is not valid.`);
                }
                if (looksLikeShortenedPubkey(trimmed)) {
                    shortenedEntries.push({ entry, index: i });
                } else {
                    nonShortenedEntries.push({ entry, index: i });
                }
            }

            // Resolve non-shortened entries upfront
            for (const { entry, index } of nonShortenedEntries) {
                resolvedPubkeys.add(resolveParticipantEntry(entry, index, isAllProjects, null));
            }

            // Collect all known pubkeys from ALL loaded conversations (before date filter)
            // so that shortened prefix resolution is independent of the date range.
            const knownPubkeysSet = new Set<string>();
            for (const { store } of allConversations) {
                for (const message of store.getAllMessages()) {
                    const pk = getConversationRecordAuthorPubkey(message);
                    if (pk) {
                        knownPubkeysSet.add(pk);
                    }
                }
            }
            const knownPubkeys = Array.from(knownPubkeysSet);

            // Resolve shortened entries against known pubkeys
            for (const { entry, index } of shortenedEntries) {
                resolvedPubkeys.add(resolveParticipantEntry(entry, index, isAllProjects, knownPubkeys));
            }

            filtered = filtered.filter(({ store }) => conversationHasAnyParticipant(store, resolvedPubkeys));
        }
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
            "Lists conversations, optionally filtered by project, date range, and participant(s). " +
            "Use 'with' for single-participant filtering or 'participants' for multi-participant OR filtering. " +
            "Results include exact stored conversation IDs, titles, summaries, participants, delegations, message counts, and timestamps. " +
            "Sorted by most recent activity. Use returned id values directly with conversation_get.",

        inputSchema: conversationListSchema,

        execute: async (input: ConversationListInput) => {
            return await executeConversationList(input, context);
        },
    });

    return aiTool as AISdkTool;
}
