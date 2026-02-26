import type { AgentInstance } from "@/agents/types";
import { conversationRegistry } from "@/conversations/ConversationRegistry";
import type { DelegationChainEntry } from "@/conversations/types";
import { formatRelativeTimeShort } from "@/lib/time";
import { RALRegistry } from "@/services/ral/RALRegistry";
import { getPubkeyService } from "@/services/PubkeyService";
import { shortenConversationId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import type { PromptFragment } from "../core/types";

/**
 * Active conversations fragment - provides context about currently active
 * conversations (agents actively streaming/working) in the project.
 *
 * Displays conversations as a hierarchical delegation tree with compact formatting.
 */

interface ActiveConversationsArgs {
    agent: AgentInstance;
    currentConversationId?: string;
    projectId?: string;
}

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

interface ConversationTreeNode {
    entry: ActiveConversationEntry;
    children: ConversationTreeNode[];
}

const MAX_CONVERSATIONS = 10;
const MAX_SUMMARY_LENGTH = 200;
const ELLIPSIS = "...";
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Sanitize text for safe inclusion in system prompt.
 * Prevents prompt injection by:
 * - Stripping/normalizing newlines
 * - Trimming excessive whitespace
 * - Clamping length (result is at most maxLength chars, including ellipsis if truncated)
 */
function sanitizeForPrompt(text: string, maxLength: number = MAX_SUMMARY_LENGTH): string {
    // Strip newlines and normalize whitespace
    let sanitized = text
        .replace(/[\r\n]+/g, " ") // Replace newlines with spaces
        .replace(/\s+/g, " ") // Collapse multiple spaces
        .trim();

    // Clamp length - ensure total output (including ellipsis) doesn't exceed maxLength
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
 * Select the primary entry from multiple entries in the same conversation.
 * Priority order:
 * 1. Streaming entries (highest priority - actively generating)
 * 2. Entries with currentTool set (running a tool)
 * 3. Entries with active tools (has tools in progress)
 * 4. Most recent activity (fallback)
 */
function selectPrimaryEntry(entries: ReturnType<RALRegistry["getActiveEntriesForProject"]>): (typeof entries)[0] {
    // 1. Prefer streaming
    const streaming = entries.find(e => e.isStreaming);
    if (streaming) return streaming;

    // 2. Prefer entries with currentTool
    const withCurrentTool = entries.find(e => e.currentTool);
    if (withCurrentTool) return withCurrentTool;

    // 3. Prefer entries with active tools
    const withActiveTools = entries.find(e => e.activeTools.size > 0);
    if (withActiveTools) return withActiveTools;

    // 4. Fall back to most recent activity
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
 * Build a tree structure from a flat list of conversation entries.
 * Children are linked to their parent; if a parent is not in the active set,
 * the child is promoted to a root node.
 *
 * Self-referential cycles (parentConversationId === conversationId) are
 * prevented by skipping self-referential parent assignments.
 * Downstream, the visited set in `getSubtreeMaxActivity` and `renderChildren`
 * prevents duplicate processing of shared nodes (i.e. a node reachable from
 * multiple parents in malformed data), but does not perform full transitive-
 * cycle detection.
 */
export function buildConversationTree(entries: ActiveConversationEntry[]): ConversationTreeNode[] {
    const nodeMap = new Map<string, ConversationTreeNode>();
    const roots: ConversationTreeNode[] = [];

    // Create nodes for all entries
    for (const entry of entries) {
        nodeMap.set(entry.conversationId, { entry, children: [] });
    }

    // Link children to parents (skip self-referential links)
    for (const entry of entries) {
        const node = nodeMap.get(entry.conversationId)!;
        const parentId = entry.parentConversationId;
        if (parentId && parentId !== entry.conversationId) {
            const parentNode = nodeMap.get(parentId);
            if (parentNode) {
                parentNode.children.push(node);
                continue;
            }
        }
        // No parent, self-referential, or parent not in active set → promote to root
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
function renderConversationLine(entry: ActiveConversationEntry): string {
    const title = entry.title || `Conversation ${shortenConversationId(entry.conversationId)}...`;
    const duration = formatDuration(entry.startedAt);
    const lastMsg = formatRelativeTimeShort(Math.floor(entry.lastActivityAt / 1000));
    const staleMarker = isStale(entry.lastActivityAt) ? " [stale]" : "";
    return `**${title}** (${entry.agentName}) - ${duration}, last msg ${lastMsg}${staleMarker}`;
}

/**
 * Check if a conversation is stale (no activity for >30 minutes).
 */
function isStale(lastActivityAtMs: number): boolean {
    return (Date.now() - lastActivityAtMs) > STALE_THRESHOLD_MS;
}

/**
 * Render a tree of conversations with tree connectors.
 * Returns an array of lines.
 */
export function renderTree(roots: ConversationTreeNode[]): string[] {
    const lines: string[] = [];

    for (let i = 0; i < roots.length; i++) {
        const root = roots[i];
        // Root line: numbered
        lines.push(`${i + 1}. ${renderConversationLine(root.entry)}`);

        // Optional summary for root
        if (root.entry.summary) {
            lines.push(`   ${root.entry.summary}`);
        }

        // Render children with tree connectors
        renderChildren(root.children, "   ", lines);

        // Blank line between root groups (except last)
        if (i < roots.length - 1) {
            lines.push("");
        }
    }

    return lines;
}

function renderChildren(children: ConversationTreeNode[], indent: string, lines: string[], visited: Set<string> = new Set()): void {
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (visited.has(child.entry.conversationId)) continue; // cycle guard
        visited.add(child.entry.conversationId);

        const isLast = i === children.length - 1;
        const connector = isLast ? "└─" : "├─";
        const childIndent = isLast ? `${indent}   ` : `${indent}│  `;

        lines.push(`${indent}${connector} ${renderConversationLine(child.entry)}`);

        // Optional summary for child
        if (child.entry.summary) {
            lines.push(`${childIndent}${child.entry.summary}`);
        }

        // Recursively render grandchildren
        renderChildren(child.children, childIndent, lines, visited);
    }
}

/**
 * Load active conversations from RALRegistry.
 * Returns conversations where agents are actively streaming or working.
 * Excludes the current conversation to avoid redundancy.
 */
function loadActiveConversations(
    _agentPubkey: string, // Not used - we show all active conversations, not filtered by agent
    currentConversationId?: string,
    projectId?: string
): ActiveConversationEntry[] {
    if (!projectId) {
        return []; // Project ID required to scope active conversations
    }

    const ralRegistry = RALRegistry.getInstance();
    const pubkeyService = getPubkeyService();

    // Get all active RAL entries for this project
    const activeEntries = ralRegistry.getActiveEntriesForProject(projectId);
    const candidateEntries: ActiveConversationEntry[] = [];

    // Group entries by conversation to deduplicate (multiple agents may be in same conversation)
    const conversationMap = new Map<string, typeof activeEntries>();
    for (const entry of activeEntries) {
        // Skip the current conversation
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
            // Get the most active/interesting entry for this conversation
            // Priority: streaming > running tool > most recent activity
            const primaryEntry = selectPrimaryEntry(entries);

            // Get conversation metadata
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

            // Get agent name
            const agentName = pubkeyService.getNameSync(primaryEntry.agentPubkey);

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
            logger.debug("Failed to get conversation metadata for active-conversations fragment", {
                conversationId,
                error: err,
            });
        }
    }

    // Sort by most recent activity first and limit to MAX_CONVERSATIONS
    candidateEntries.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return candidateEntries.slice(0, MAX_CONVERSATIONS);
}

export const activeConversationsFragment: PromptFragment<ActiveConversationsArgs> = {
    id: "active-conversations",
    priority: 8, // Before recent conversations (9)
    template: ({ agent, currentConversationId, projectId }) => {
        const activeConversations = loadActiveConversations(agent.pubkey, currentConversationId, projectId);

        if (activeConversations.length === 0) {
            return ""; // No active conversations to show
        }

        // Build hierarchical tree from flat list
        const roots = buildConversationTree(activeConversations);

        // Sort tree by most recent subtree activity
        const sortedRoots = sortTree(roots);

        // Render tree with connectors
        const lines = renderTree(sortedRoots);

        return `## Active Conversations

The following conversations are currently active in this project (agents working):

${lines.join("\n")}

---`;
    },
};
