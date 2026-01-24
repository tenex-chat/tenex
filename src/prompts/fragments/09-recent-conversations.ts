import type { AgentInstance } from "@/agents/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import { formatRelativeTimeShort } from "@/lib/time";
import { logger } from "@/utils/logger";
import type { PromptFragment } from "../core/types";

/**
 * Recent conversations fragment - provides context about conversations
 * the agent participated in during the last 24 hours.
 *
 * This gives agents "short-term memory" by surfacing recent activity summaries.
 */

interface RecentConversationsArgs {
    agent: AgentInstance;
    currentConversationId?: string;
    projectId?: string;
}

interface RecentConversationEntry {
    id: string;
    title?: string;
    summary?: string;
    lastActivity: number;
}

const TWENTY_FOUR_HOURS_IN_SECONDS = 24 * 60 * 60;
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
 * Load recent conversations where the agent participated in the last 24 hours.
 * Excludes the current conversation to avoid redundancy.
 *
 * Performance: Uses readConversationPreview for single disk read per conversation
 * (metadata + participation check combined). Does not grow global cache.
 */
function loadRecentConversations(
    agentPubkey: string,
    currentConversationId?: string,
    projectId?: string
): RecentConversationEntry[] {
    const now = Math.floor(Date.now() / 1000);
    const cutoffTime = now - TWENTY_FOUR_HOURS_IN_SECONDS;

    // Use project-specific listing if projectId is provided, otherwise fall back to current project
    const conversationIds = projectId
        ? ConversationStore.listConversationIdsFromDiskForProject(projectId)
        : ConversationStore.listConversationIdsFromDisk();
    const candidateEntries: RecentConversationEntry[] = [];

    for (const conversationId of conversationIds) {
        // Skip the current conversation
        if (conversationId === currentConversationId) {
            continue;
        }

        try {
            // Single disk read: gets metadata + participation check together
            // Use project-aware method when projectId is provided for full scoping
            const preview = projectId
                ? ConversationStore.readConversationPreviewForProject(conversationId, agentPubkey, projectId)
                : ConversationStore.readConversationPreview(conversationId, agentPubkey);
            if (!preview) continue;

            // Skip conversations older than 24 hours
            if (preview.lastActivity < cutoffTime) {
                continue;
            }

            // Skip if agent didn't participate
            if (!preview.agentParticipated) {
                continue;
            }

            // Build summary - ONLY use generated summaries to prevent prompt injection
            // Raw user text is NOT included in the system prompt
            const summary = preview.summary
                ? sanitizeForPrompt(preview.summary)
                : "[No summary available]";

            candidateEntries.push({
                id: preview.id,
                title: preview.title,
                summary,
                lastActivity: preview.lastActivity,
            });
        } catch (err) {
            logger.debug("Failed to read conversation preview for recent-conversations fragment", {
                conversationId,
                error: err,
            });
        }
    }

    // Sort by most recent activity first and limit to MAX_CONVERSATIONS
    candidateEntries.sort((a, b) => b.lastActivity - a.lastActivity);
    return candidateEntries.slice(0, MAX_CONVERSATIONS);
}

export const recentConversationsFragment: PromptFragment<RecentConversationsArgs> = {
    id: "recent-conversations",
    priority: 9, // Early in the prompt, after identity but before other context
    template: ({ agent, currentConversationId, projectId }) => {
        const recentConversations = loadRecentConversations(agent.pubkey, currentConversationId, projectId);

        if (recentConversations.length === 0) {
            return ""; // No recent conversations to show
        }

        const conversationLines = recentConversations.map((conv, index) => {
            const title = conv.title || `Conversation ${conv.id.substring(0, 8)}...`;
            const relativeTime = formatRelativeTimeShort(conv.lastActivity);
            // Summary is already sanitized (no newlines), safe to include inline
            const summaryLine = conv.summary ? `\n   Summary: ${conv.summary}` : "";

            return `${index + 1}. **${title}** (${relativeTime})${summaryLine}`;
        });

        return `## Recent Conversations (Past 24h)

You participated in the following conversations recently. This context may help you understand ongoing work:

${conversationLines.join("\n\n")}

---`;
    },
};
