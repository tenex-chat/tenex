import { join } from "node:path";
import { conversationRegistry } from "@/conversations/ConversationRegistry";
import { ConversationCatalogService } from "@/conversations/ConversationCatalogService";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { DelegationChainEntry } from "@/conversations/types";
import { formatRelativeTimeShort } from "@/lib/time";
import { RALRegistry } from "@/services/ral/RALRegistry";
import { getIdentityService } from "@/services/identity";
import { logger } from "@/utils/logger";
import type { ProjectDTag } from "@/types/project-ids";
import { shortenConversationId } from "@/utils/conversation-id";

// ── Constants ──────────────────────────────────────────────────────────

const MAX_CONVERSATIONS = 10;
const MAX_SUMMARY_LENGTH = 200;
const ELLIPSIS = "...";
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const TWENTY_FOUR_HOURS_IN_SECONDS = 24 * 60 * 60;

// ── Types ──────────────────────────────────────────────────────────────

interface ActiveConversationEntry {
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

export interface ConversationTreeNode {
    entry: ActiveConversationEntry;
    children: ConversationTreeNode[];
}

interface RecentConversationEntry {
    id: string;
    title?: string;
    summary?: string;
    lastActivity: number;
}

interface RenderConversationsArgs {
    agentPubkey: string;
    currentConversationId?: string;
    projectId?: ProjectDTag;
}

// ── Text utilities ─────────────────────────────────────────────────────

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

function isStale(lastActivityAtMs: number): boolean {
    return (Date.now() - lastActivityAtMs) > STALE_THRESHOLD_MS;
}

// ── Active conversations: loading ──────────────────────────────────────

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

export function extractParentFromDelegationChain(chain?: DelegationChainEntry[]): string | undefined {
    if (!chain || chain.length < 2) return undefined;
    return chain[chain.length - 2].conversationId;
}

function loadActiveConversations(
    currentConversationId?: string,
    projectId?: ProjectDTag
): ActiveConversationEntry[] {
    if (!projectId) {
        return [];
    }

    const ralRegistry = RALRegistry.getInstance();
    const identityService = getIdentityService();
    const activeEntries = ralRegistry.getActiveEntriesForProject(projectId);
    const candidateEntries: ActiveConversationEntry[] = [];

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

export function buildConversationTree(entries: ActiveConversationEntry[]): ConversationTreeNode[] {
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

function renderConversationLine(entry: ActiveConversationEntry): string {
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

function renderActiveConversationsSection(activeConversations: ActiveConversationEntry[]): string | null {
    if (activeConversations.length === 0) {
        return null;
    }

    const roots = buildConversationTree(activeConversations);
    const sortedRoots = sortTree(roots);
    const lines = renderTree(sortedRoots);

    return `<active>
The following conversations are currently active in this project (agents working). Use the exact id shown with conversation_get if you need to inspect one:

${lines.join("\n")}
</active>`;
}

// ── Recent conversations: loading & rendering ──────────────────────────

function loadRecentConversations(
    agentPubkey: string,
    currentConversationId?: string,
    projectId?: ProjectDTag,
    activeConversationIds?: Set<string>
): RecentConversationEntry[] {
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

        // Deduplicate: remove any that are already in active conversations
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
    agentPubkey: string,
    currentConversationId?: string,
    projectId?: ProjectDTag,
    activeConversationIds?: Set<string>
): string | null {
    const recentConversations = loadRecentConversations(
        agentPubkey,
        currentConversationId,
        projectId,
        activeConversationIds
    );

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
You participated in the following conversations recently. This context may help you understand ongoing work. Use the exact id shown with conversation_get if you need to reopen one:

${conversationLines.join("\n\n")}
</recent>`;
}

// ── Public API ─────────────────────────────────────────────────────────

export function renderConversationsReminder(args: RenderConversationsArgs): string | null {
    const { agentPubkey, currentConversationId, projectId } = args;

    // Load active conversations once, use for both rendering and deduplication
    const activeConversations = loadActiveConversations(currentConversationId, projectId);
    const activeSection = renderActiveConversationsSection(activeConversations);

    // Collect active conversation IDs for deduplication against recent
    const activeConversationIds = new Set<string>(activeConversations.map(c => c.conversationId));

    const recentSection = renderRecentConversationsSection(
        agentPubkey,
        currentConversationId,
        projectId,
        activeConversationIds
    );

    if (!activeSection && !recentSection) {
        return null;
    }

    const sections: string[] = [];
    if (activeSection) sections.push(activeSection);
    if (recentSection) sections.push(recentSection);

    return sections.join("\n");
}
