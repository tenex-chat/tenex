import type { AgentInstance } from "@/agents/types";
import { join } from "node:path";
import { ConversationCatalogService } from "@/conversations/ConversationCatalogService";
import { ConversationStore } from "@/conversations/ConversationStore";
import { formatRelativeTimeShort } from "@/lib/time";
import { logger } from "@/utils/logger";
import type { PromptFragment } from "../core/types";
import type { ProjectDTag } from "@/types/project-ids";

/**
 * Recent conversations fragment - provides context about conversations
 * the agent participated in during the last 24 hours.
 *
 * This gives agents "short-term memory" by surfacing recent activity summaries.
 */

interface RecentConversationsArgs {
    agent: AgentInstance;
    currentConversationId?: string;
    projectId?: ProjectDTag;
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

function truncateConversationIdForDisplay(conversationId: string, maxLength = 12): string {
    if (conversationId.length <= maxLength) {
        return conversationId;
    }
    return `${conversationId.substring(0, maxLength)}${ELLIPSIS}`;
}

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
    projectId?: ProjectDTag
): RecentConversationEntry[] {
    const now = Math.floor(Date.now() / 1000);
    const cutoffTime = now - TWENTY_FOUR_HOURS_IN_SECONDS;
    const effectiveProjectId = projectId ?? ConversationStore.getProjectId();
    if (!effectiveProjectId) {
        return [];
    }

    try {
        return ConversationCatalogService.getInstance(
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
    } catch (err) {
        logger.debug("Failed to load recent conversations from catalog", {
            projectId: effectiveProjectId,
            error: err,
        });
        return [];
    }
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
            const title = conv.title || `Conversation ${truncateConversationIdForDisplay(conv.id)}`;
            const relativeTime = formatRelativeTimeShort(conv.lastActivity);
            // Summary is already sanitized (no newlines), safe to include inline
            const summaryLine = conv.summary ? `\n   Summary: ${conv.summary}` : "";

            return `${index + 1}. **${title}** (${relativeTime}) [id: ${conv.id}]${summaryLine}`;
        });

        return `## Recent Conversations (Past 24h)

You participated in the following conversations recently. This context may help you understand ongoing work. Use the exact \`id\` shown with \`conversation_get\` if you need to reopen one:

${conversationLines.join("\n\n")}

---`;
    },
};
