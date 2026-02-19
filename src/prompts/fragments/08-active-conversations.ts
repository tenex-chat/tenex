import type { AgentInstance } from "@/agents/types";
import { conversationRegistry } from "@/conversations/ConversationRegistry";
import { formatRelativeTimeShort } from "@/lib/time";
import { RALRegistry } from "@/services/ral/RALRegistry";
import { getPubkeyService } from "@/services/PubkeyService";
import { logger } from "@/utils/logger";
import type { PromptFragment } from "../core/types";

/**
 * Active conversations fragment - provides context about currently active
 * conversations (agents actively streaming/working) in the project.
 *
 * This gives agents awareness of concurrent activity happening in the project.
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
}

const MAX_CONVERSATIONS = 10;
const MAX_SUMMARY_LENGTH = 200;
const ELLIPSIS = "...";

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

            if (store) {
                const metadata = store.getMetadata();
                title = metadata.title;
                summary = metadata.summary ? sanitizeForPrompt(metadata.summary) : undefined;
                messageCount = store.getAllMessages().length;
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

        const conversationLines = activeConversations.map((conv, index) => {
            const title = conv.title || `Conversation ${conv.conversationId.substring(0, 8)}...`;
            const duration = formatDuration(conv.startedAt);
            const lastActivity = formatRelativeTimeShort(Math.floor(conv.lastActivityAt / 1000));

            // Build status string
            let status: string;
            if (conv.isStreaming) {
                status = "streaming";
            } else if (conv.currentTool) {
                status = `running ${conv.currentTool}`;
            } else {
                status = "active";
            }

            const summaryLine = conv.summary ? `\n   Summary: ${conv.summary}` : "";

            return `${index + 1}. **${title}**
   - ID: ${conv.conversationId}
   - Agent: ${conv.agentName}
   - Status: ${status}
   - Duration: ${duration}
   - Messages: ${conv.messageCount}
   - Last activity: ${lastActivity}${summaryLine}`;
        });

        return `## Active Conversations

The following conversations are currently active in this project (agents working):

${conversationLines.join("\n\n")}

---`;
    },
};
