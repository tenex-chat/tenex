import { join } from "node:path";
import { conversationRegistry } from "@/conversations/ConversationRegistry";
import { ConversationCatalogService } from "@/conversations/ConversationCatalogService";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { DelegationChainEntry } from "@/conversations/types";
import { formatRelativeTimeShort } from "@/lib/time";
import { RALRegistry } from "@/services/ral/RALRegistry";
import { getIdentityService } from "@/services/identity";
import { logger } from "@/utils/logger";
import { shortenConversationId } from "@/utils/conversation-id";
import type { ProjectDTag } from "@/types/project-ids";

// ── Constants ──────────────────────────────────────────────────────────

const MAX_CONVERSATIONS = 10;
const MAX_SUMMARY_LENGTH = 200;
const ELLIPSIS = "...";
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const TWENTY_FOUR_HOURS_IN_SECONDS = 24 * 60 * 60;

// ── Types ──────────────────────────────────────────────────────────────

export interface ActiveConversationReminderEntry {
    conversationId: string;
    title?: string;
    summary?: string;
    agentName: string;
    agentPubkey: string;
    isStreaming: boolean;
    currentTool?: string;
    startedAt: number;
    lastActivityAt: number;
    messageCount: number;
    parentConversationId?: string;
}

interface ConversationTreeNode {
    entry: ActiveConversationReminderEntry;
    children: ConversationTreeNode[];
}

export interface RecentConversationReminderEntry {
    id: string;
    title?: string;
    summary?: string;
    lastActivity: number;
}

export interface ConversationsReminderSnapshot {
    active: ActiveConversationReminderEntry[];
    recent: RecentConversationReminderEntry[];
}

interface RenderConversationsReminderArgs {
    agentPubkey: string;
    currentConversationId?: string;
    projectId?: ProjectDTag;
}

// ── Text utilities ─────────────────────────────────────────────────────

/**
 * Sanitize text for safe inclusion in system prompt.
 * Prevents prompt injection by:
 * - Stripping/normalizing newlines
 * - Trimming excessive whitespace
 * - Clamping length (result is at most maxLength chars, including ellipsis if truncated)
 */
function sanitizeForPrompt(text: string, maxLength: number = MAX_SUMMARY_LENGTH): string {
    let sanitized = text
        .replace(/[\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (sanitized.length > maxLength) {
        sanitized = sanitized.substring(0, maxLength - ELLIPSIS.length) + ELLIPSIS;
    }

    return sanitized;
}

/**
 * Format duration since a timestamp into a human-readable string.
 * Example: "2m", "1h 30m", "5s"
 */
function formatDuration(startTimestampMs: number): string {
    const now = Date.now();
    const durationMs = now - startTimestampMs;
    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        const remainingMinutes = minutes % 60;
        return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
    }
    if (minutes > 0) {
        return `${minutes}m`;
    }
    return `${seconds}s`;
}

/**
 * Check if a conversation is stale (no activity for >30 minutes).
 */
function isStale(lastActivityAtMs: number): boolean {
    return (Date.now() - lastActivityAtMs) > STALE_THRESHOLD_MS;
}

// ── Active conversations: loading ──────────────────────────────────────

/**
 * Select the primary entry from multiple entries in the same conversation.
 * Priority order:
 * 1. Streaming entries (highest priority - actively generating)
 * 2. Entries with currentTool set (running a tool)
 * 3. Entries with active tools (has tools in progress)
 * 4. Most recent activity (fallback)
 */
function selectPrimaryEntry(entries: ReturnType<RALRegistry["getActiveEntriesForProject"]>): (typeof entries)[0] {
    const streaming = entries.find(e => e.isStreaming);
    if (streaming) return streaming;

    const withCurrentTool = entries.find(e => e.currentTool);
    if (withCurrentTool) return withCurrentTool;

    const withActiveTools = entries.find(e => e.activeTools.size > 0);
    if (withActiveTools) return withActiveTools;

    return entries.reduce((mostRecent, entry) =>
        entry.lastActivityAt > mostRecent.lastActivityAt ? entry : mostRecent
    );
}

/**
 * Extract the parent conversation ID from a delegation chain.
 * The second-to-last entry in the chain is the parent conversation.
 */
export function extractParentFromDelegationChain(chain?: DelegationChainEntry[]): string | undefined {
    if (!chain || chain.length < 2) return undefined;
    return chain[chain.length - 2].conversationId;
}

/**
 * Load active conversations from RALRegistry.
 * Returns conversations where agents are actively streaming or working.
 * Excludes the current conversation to avoid redundancy.
 */
function loadActiveConversations(
    currentConversationId?: string,
    projectId?: ProjectDTag
): ActiveConversationReminderEntry[] {
    if (!projectId) {
        return [];
    }

    const ralRegistry = RALRegistry.getInstance();
    const identityService = getIdentityService();
    const activeEntries = ralRegistry.getActiveEntriesForProject(projectId);
    const candidateEntries: ActiveConversationReminderEntry[] = [];

    const conversationMap = new Map<string, typeof activeEntries>();
    for (const entry of activeEntries) {
        if (entry.conversationId === currentConversationId) {
            continue;
        }

        const existing = conversationMap.get(entry.conversationId);
        if (existing) {
            existing.push(entry);
        } else {
            conversationMap.set(entry.conversationId, [entry]);
        }
    }

    for (const [conversationId, entries] of conversationMap) {
        try {
            const primaryEntry = selectPrimaryEntry(entries);
            const store = conversationRegistry.get(conversationId);
            let title: string | undefined;
            let summary: string | undefined;
            let messageCount = 0;
            let parentConversationId: string | undefined;

            if (store) {
                const metadata = store.getMetadata();
                title = metadata.title;
                summary = metadata.summary ? sanitizeForPrompt(metadata.summary) : undefined;
                messageCount = store.getAllMessages().length;
                parentConversationId = extractParentFromDelegationChain(metadata.delegationChain);
            }

            const agentName = identityService.getNameSync(primaryEntry.agentPubkey);

            candidateEntries.push({
                conversationId,
                title,
                summary,
                agentName,
                agentPubkey: primaryEntry.agentPubkey,
                isStreaming: primaryEntry.isStreaming,
                currentTool: primaryEntry.currentTool,
                startedAt: primaryEntry.createdAt,
                lastActivityAt: primaryEntry.lastActivityAt,
                messageCount,
                parentConversationId,
            });
        } catch (err) {
            logger.debug("Failed to get conversation metadata for conversations reminder", {
                conversationId,
                error: err,
            });
        }
    }

    candidateEntries.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return candidateEntries.slice(0, MAX_CONVERSATIONS);
}

// ── Active conversations: tree building & rendering ────────────────────

export function buildConversationTree(entries: ActiveConversationReminderEntry[]): ConversationTreeNode[] {
    const nodeMap = new Map<string, ConversationTreeNode>();
    const roots: ConversationTreeNode[] = [];

    for (const entry of entries) {
        nodeMap.set(entry.conversationId, { entry, children: [] });
    }

    for (const entry of entries) {
        const node = nodeMap.get(entry.conversationId);
        if (!node) continue;
        const parentId = entry.parentConversationId;
        if (parentId && parentId !== entry.conversationId) {
            const parentNode = nodeMap.get(parentId);
            if (parentNode) {
                parentNode.children.push(node);
                continue;
            }
        }
        roots.push(node);
    }

    return roots;
}

/**
 * Get the maximum lastActivityAt across an entire subtree (node + all descendants).
 * Uses a visited set to guard against cycles in malformed data.
 */
function getSubtreeMaxActivity(node: ConversationTreeNode, visited: Set<string> = new Set()): number {
    if (visited.has(node.entry.conversationId)) return node.entry.lastActivityAt;
    visited.add(node.entry.conversationId);

    let max = node.entry.lastActivityAt;
    for (const child of node.children) {
        const childMax = getSubtreeMaxActivity(child, visited);
        if (childMax > max) max = childMax;
    }
    return max;
}

/**
 * Sort tree roots by max subtree activity (most recent first).
 * Returns a new array with recursively sorted children (does not mutate the input).
 */
export function sortTree(roots: ConversationTreeNode[]): ConversationTreeNode[] {
    return [...roots]
        .map(root => sortNodeChildren(root))
        .sort((a, b) => getSubtreeMaxActivity(b) - getSubtreeMaxActivity(a));
}

function sortNodeChildren(node: ConversationTreeNode): ConversationTreeNode {
    const sortedChildren = [...node.children]
        .map(child => sortNodeChildren(child))
        .sort((a, b) => getSubtreeMaxActivity(b) - getSubtreeMaxActivity(a));
    return { ...node, children: sortedChildren };
}

/**
 * Render a single conversation line in compact format.
 */
function renderConversationLine(entry: ActiveConversationReminderEntry): string {
    const title = entry.title || `Conversation ${shortenConversationId(entry.conversationId)}`;
    const duration = formatDuration(entry.startedAt);
    const lastMsg = formatRelativeTimeShort(Math.floor(entry.lastActivityAt / 1000));
    const staleMarker = isStale(entry.lastActivityAt) ? " [stale]" : "";
    return `**${title}** (${entry.agentName}) - ${duration}, last msg ${lastMsg}${staleMarker} [id: ${shortenConversationId(entry.conversationId)}]`;
}

export function renderTree(roots: ConversationTreeNode[]): string[] {
    const lines: string[] = [];

    for (let i = 0; i < roots.length; i++) {
        const root = roots[i];
        lines.push(`${i + 1}. ${renderConversationLine(root.entry)}`);

        if (root.entry.summary) {
            lines.push(`   ${root.entry.summary}`);
        }

        renderChildren(root.children, "   ", lines);

        if (i < roots.length - 1) {
            lines.push("");
        }
    }

    return lines;
}

function renderChildren(children: ConversationTreeNode[], indent: string, lines: string[], visited: Set<string> = new Set()): void {
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (visited.has(child.entry.conversationId)) continue;
        visited.add(child.entry.conversationId);

        const isLast = i === children.length - 1;
        const connector = isLast ? "└─" : "├─";
        const childIndent = isLast ? `${indent}   ` : `${indent}│  `;

        lines.push(`${indent}${connector} ${renderConversationLine(child.entry)}`);

        if (child.entry.summary) {
            lines.push(`${childIndent}${child.entry.summary}`);
        }

        renderChildren(child.children, childIndent, lines, visited);
    }
}

function renderActiveConversationsSection(
    activeConversations: ActiveConversationReminderEntry[]
): string | null {
    if (activeConversations.length === 0) {
        return null;
    }

    const roots = buildConversationTree(activeConversations);
    const sortedRoots = sortTree(roots);
    const lines = renderTree(sortedRoots);

    return `<active>
The following conversations are currently active in this project (agents working). Use \`conversation_get <id>\` with the short id shown if you need to inspect one:

${lines.join("\n")}
</active>`;
}

// ── Recent conversations: loading & rendering ──────────────────────────

function loadRecentConversations(
    agentPubkey: string,
    currentConversationId?: string,
    projectId?: ProjectDTag,
    activeConversationIds?: Set<string>
): RecentConversationReminderEntry[] {
    const now = Math.floor(Date.now() / 1000);
    const cutoffTime = now - TWENTY_FOUR_HOURS_IN_SECONDS;
    const effectiveProjectId = projectId ?? ConversationStore.getProjectId();
    if (!effectiveProjectId) {
        return [];
    }

    try {
        const results = ConversationCatalogService.getInstance(
            effectiveProjectId,
            join(ConversationStore.getBasePath(), effectiveProjectId)
        )
            .queryRecentForParticipant({
                participantPubkey: agentPubkey,
                excludeConversationId: currentConversationId,
                since: cutoffTime,
                limit: MAX_CONVERSATIONS,
            })
            .map((preview) => ({
                id: preview.id,
                title: preview.title,
                summary: preview.summary
                    ? sanitizeForPrompt(preview.summary)
                    : "[No summary available]",
                lastActivity: preview.lastActivity,
            }));

        if (activeConversationIds && activeConversationIds.size > 0) {
            return results.filter(entry => !activeConversationIds.has(entry.id));
        }
        return results;
    } catch (err) {
        logger.debug("Failed to load recent conversations from catalog", {
            projectId: effectiveProjectId,
            error: err,
        });
        return [];
    }
}

function renderRecentConversationsSection(
    recentConversations: RecentConversationReminderEntry[]
): string | null {
    if (recentConversations.length === 0) {
        return null;
    }

    const conversationLines = recentConversations.map((conv, index) => {
        const title = conv.title || `Conversation ${shortenConversationId(conv.id)}`;
        const relativeTime = formatRelativeTimeShort(conv.lastActivity);
        const summaryLine = conv.summary ? `\n   Summary: ${conv.summary}` : "";
        return `${index + 1}. **${title}** (${relativeTime}) [id: ${shortenConversationId(conv.id)}]${summaryLine}`;
    });

    return `<recent>
You participated in the following conversations recently. Use \`conversation_get <id>\` with the short id shown if you need to reopen one:

${conversationLines.join("\n\n")}
</recent>`;
}

// ── Public API ─────────────────────────────────────────────────────────

function renderConversationReference(
    entry:
        | Pick<ActiveConversationReminderEntry, "conversationId" | "title">
        | Pick<RecentConversationReminderEntry, "id" | "title">
): string {
    const conversationId = "conversationId" in entry ? entry.conversationId : entry.id;
    const title = entry.title || `Conversation ${shortenConversationId(conversationId)}`;
    return `**${title}** [id: ${shortenConversationId(conversationId)}]`;
}

function summarizeActiveConversationChanges(
    previous: ActiveConversationReminderEntry,
    current: ActiveConversationReminderEntry
): string[] {
    const changes: string[] = [];

    if ((previous.title ?? "") !== (current.title ?? "")) {
        changes.push("title changed");
    }
    if ((previous.summary ?? "") !== (current.summary ?? "")) {
        changes.push("summary changed");
    }
    if ((previous.currentTool ?? "") !== (current.currentTool ?? "")) {
        if (current.currentTool) {
            changes.push(`tool is now \`${current.currentTool}\``);
        } else if (previous.currentTool) {
            changes.push(`tool \`${previous.currentTool}\` finished`);
        }
    }
    if (previous.isStreaming !== current.isStreaming) {
        changes.push(current.isStreaming ? "streaming started" : "streaming stopped");
    }
    if (previous.agentName !== current.agentName) {
        changes.push(`agent is now ${current.agentName}`);
    }

    return changes;
}

function summarizeRecentConversationChanges(
    previous: RecentConversationReminderEntry,
    current: RecentConversationReminderEntry
): string[] {
    const changes: string[] = [];

    if ((previous.title ?? "") !== (current.title ?? "")) {
        changes.push("title changed");
    }
    if ((previous.summary ?? "") !== (current.summary ?? "")) {
        changes.push("summary changed");
    }

    return changes;
}

export function buildConversationsReminderSnapshot({
    agentPubkey,
    currentConversationId,
    projectId,
}: RenderConversationsReminderArgs): ConversationsReminderSnapshot {
    const active = loadActiveConversations(currentConversationId, projectId);
    const activeConversationIds = new Set<string>(active.map((conversation) => conversation.conversationId));
    const recent = loadRecentConversations(
        agentPubkey,
        currentConversationId,
        projectId,
        activeConversationIds
    );

    return { active, recent };
}

export function renderConversationsReminderFromSnapshot(
    snapshot: ConversationsReminderSnapshot
): string | null {
    const activeSection = renderActiveConversationsSection(snapshot.active);
    const recentSection = renderRecentConversationsSection(snapshot.recent);

    if (!activeSection && !recentSection) {
        return null;
    }

    const sections: string[] = [];
    if (activeSection) sections.push(activeSection);
    if (recentSection) sections.push(recentSection);

    return sections.join("\n");
}

export function renderConversationsReminderDelta(
    previous: ConversationsReminderSnapshot,
    current: ConversationsReminderSnapshot
): string | null {
    const lines: string[] = [];
    const previousActive = new Map(previous.active.map((entry) => [entry.conversationId, entry]));
    const currentActive = new Map(current.active.map((entry) => [entry.conversationId, entry]));
    const previousRecent = new Map(previous.recent.map((entry) => [entry.id, entry]));
    const currentRecent = new Map(current.recent.map((entry) => [entry.id, entry]));

    for (const [conversationId, entry] of previousActive) {
        if (currentActive.has(conversationId)) {
            continue;
        }

        if (currentRecent.has(conversationId)) {
            lines.push(
                `Active conversation moved to recent: ${renderConversationReference(
                    currentRecent.get(conversationId)!
                )}.`
            );
            continue;
        }

        lines.push(`Active conversation ended: ${renderConversationReference(entry)}.`);
    }

    for (const [conversationId, entry] of currentActive) {
        const previousEntry = previousActive.get(conversationId);
        if (!previousEntry) {
            lines.push(`Active conversation started: ${renderConversationReference(entry)}.`);
            continue;
        }

        const changes = summarizeActiveConversationChanges(previousEntry, entry);
        if (changes.length > 0) {
            lines.push(
                `Active conversation updated: ${renderConversationReference(entry)} (${changes.join(", ")}).`
            );
        }
    }

    for (const [conversationId, entry] of currentRecent) {
        if (previousRecent.has(conversationId) || previousActive.has(conversationId)) {
            continue;
        }

        lines.push(`Recent conversation added: ${renderConversationReference(entry)}.`);
    }

    for (const [conversationId, entry] of currentRecent) {
        const previousEntry = previousRecent.get(conversationId);
        if (!previousEntry) {
            continue;
        }

        const changes = summarizeRecentConversationChanges(previousEntry, entry);
        if (changes.length > 0) {
            lines.push(
                `Recent conversation updated: ${renderConversationReference(entry)} (${changes.join(", ")}).`
            );
        }
    }

    if (lines.length === 0) {
        return null;
    }

    return ["<updates>", ...lines.map((line) => `- ${line}`), "</updates>"].join("\n");
}

export function renderConversationsReminder({
    agentPubkey,
    currentConversationId,
    projectId,
}: RenderConversationsReminderArgs): string | null {
    return renderConversationsReminderFromSnapshot(
        buildConversationsReminderSnapshot({
            agentPubkey,
            currentConversationId,
            projectId,
        })
    );
}
