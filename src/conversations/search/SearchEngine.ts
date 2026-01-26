/**
 * SearchEngine - Pure search logic for conversation index.
 *
 * Handles:
 * - Agent filtering (conversation must have at least one matching agent)
 * - Date filtering (lastMessageAt >= since)
 * - Case-insensitive text matching on message content
 * - Snippet extraction for matches
 * - Sorting by lastActivity descending
 */

import type {
    ConversationIndex,
    ConversationIndexEntry,
    MessageMatch,
    SearchQuery,
    SearchResult,
} from "./types";
import { extractSnippet } from "./SnippetExtractor";
import { getEffectiveSinceTimestamp } from "./QueryParser";

/**
 * Check if a conversation matches the agent filter.
 * Returns true if no filter is specified or if at least one agent EXACTLY matches.
 * Uses case-insensitive exact matching for agent slugs/pubkeys.
 */
function matchesAgentFilter(conversation: ConversationIndexEntry, agentFilter?: string[]): boolean {
    if (!agentFilter || agentFilter.length === 0) {
        return true;
    }

    // Convert agent filter to lowercase for case-insensitive exact matching
    const filterLower = new Set(agentFilter.map((a) => a.toLowerCase().trim()));

    // Check if any conversation agent exactly matches any filter agent
    return conversation.agents.some((agent) => {
        const agentLower = agent.toLowerCase().trim();
        return filterLower.has(agentLower);
    });
}

/**
 * Check if a conversation matches the date filter.
 * Returns true if no filter is specified or if lastMessageAt >= since.
 */
function matchesDateFilter(conversation: ConversationIndexEntry, sinceTimestamp?: number): boolean {
    if (sinceTimestamp === undefined) {
        return true;
    }

    const lastMessageAt = conversation.lastMessageAt ?? 0;
    return lastMessageAt >= sinceTimestamp;
}

/**
 * Find matching messages in a conversation and extract snippets.
 */
function findMatchingMessages(
    conversation: ConversationIndexEntry,
    searchText: string,
    maxMatches: number = 3
): MessageMatch[] {
    const matches: MessageMatch[] = [];
    const searchLower = searchText.toLowerCase();

    for (const message of conversation.messages) {
        if (matches.length >= maxMatches) break;

        const contentLower = message.content.toLowerCase();
        if (contentLower.includes(searchLower)) {
            const snippetResult = extractSnippet(message.content, searchText);
            if (snippetResult) {
                matches.push({
                    messageId: message.messageId,
                    snippet: snippetResult.snippet,
                });
            }
        }
    }

    return matches;
}

/**
 * Search the conversation index.
 *
 * @param query - Parsed search query with text and filters
 * @param index - The conversation index to search
 * @param limit - Maximum number of results to return
 * @returns Array of search results sorted by lastActivity descending
 */
export function search(
    query: SearchQuery,
    index: ConversationIndex,
    limit: number = 20
): SearchResult[] {
    const results: SearchResult[] = [];
    const sinceTimestamp = getEffectiveSinceTimestamp(query.filters);

    for (const conversation of index.conversations) {
        // Apply filters
        if (!matchesAgentFilter(conversation, query.filters.agents)) {
            continue;
        }

        if (!matchesDateFilter(conversation, sinceTimestamp)) {
            continue;
        }

        // Search for text matches
        const matches = findMatchingMessages(conversation, query.text);

        // Only include conversations with at least one match
        if (matches.length === 0) {
            continue;
        }

        results.push({
            conversationId: conversation.conversationId,
            title: conversation.title,
            messageCount: conversation.messageCount,
            createdAt: conversation.messages[0]?.timestamp,
            lastActivity: conversation.lastMessageAt,
            matches,
        });
    }

    // Sort by lastActivity descending (most recent first)
    results.sort((a, b) => {
        const aTime = a.lastActivity ?? 0;
        const bTime = b.lastActivity ?? 0;
        return bTime - aTime;
    });

    // Apply limit
    return results.slice(0, limit);
}

/**
 * Search with title-only fallback for backward compatibility.
 * This searches only by title, not message content.
 */
export function searchByTitleOnly(
    query: string,
    index: ConversationIndex,
    limit: number = 20
): SearchResult[] {
    const results: SearchResult[] = [];
    const queryLower = query.toLowerCase();

    for (const conversation of index.conversations) {
        if (conversation.title && conversation.title.toLowerCase().includes(queryLower)) {
            results.push({
                conversationId: conversation.conversationId,
                title: conversation.title,
                messageCount: conversation.messageCount,
                createdAt: conversation.messages[0]?.timestamp,
                lastActivity: conversation.lastMessageAt,
                matches: [{
                    messageId: "title",
                    snippet: conversation.title,
                }],
            });
        }
    }

    // Sort by lastActivity descending
    results.sort((a, b) => {
        const aTime = a.lastActivity ?? 0;
        const bTime = b.lastActivity ?? 0;
        return bTime - aTime;
    });

    return results.slice(0, limit);
}
