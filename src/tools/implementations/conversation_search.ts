import type { ToolExecutionContext } from "@/tools/types";
import { conversationRegistry } from "@/conversations/ConversationRegistry";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { MessageMatch } from "@/conversations/search";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const conversationSearchSchema = z.object({
    query: z.string().describe("Search query text to match against conversation content"),
    filters: z
        .object({
            agents: z
                .array(z.string())
                .optional()
                .describe("Filter by agent slugs or pubkeys - conversation must include at least one (exact match)"),
            since: z
                .union([z.string(), z.number()])
                .optional()
                .describe("Return conversations with activity since this date (Unix timestamp or ISO 8601)"),
            after: z
                .union([z.string(), z.number()])
                .optional()
                .describe("Alias for 'since' - return conversations with activity after this date"),
        })
        .optional()
        .describe("Optional filters to narrow search results"),
    limit: z
        .number()
        .optional()
        .default(20)
        .describe("Maximum number of results to return. Defaults to 20."),
});

type ConversationSearchInput = z.infer<typeof conversationSearchSchema>;

interface ConversationSearchResult {
    id: string;
    title?: string;
    messageCount: number;
    createdAt?: number;
    lastActivity?: number;
    matches?: MessageMatch[];
}

interface ConversationSearchOutput {
    success: boolean;
    conversations: ConversationSearchResult[];
    total: number;
    query: string;
    searchType: "full-text" | "title-only";
    error?: string;
    warning?: string;
}

/**
 * Fallback to legacy title-only search using in-memory stores.
 */
function legacyTitleSearch(query: string, limit: number): ConversationSearchResult[] {
    const stores = ConversationStore.search(query);
    return stores.slice(0, limit).map((store) => {
        const messages = store.getAllMessages();
        const firstMessage = messages[0];
        const lastMessage = messages[messages.length - 1];

        return {
            id: store.id,
            title: store.title,
            messageCount: messages.length,
            createdAt: firstMessage?.timestamp,
            lastActivity: lastMessage?.timestamp,
        };
    });
}

async function executeConversationSearch(
    input: ConversationSearchInput,
    context: ToolExecutionContext
): Promise<ConversationSearchOutput> {
    const { query, filters, limit = 20 } = input;

    logger.info("🔍 Searching conversations", {
        query,
        filters,
        limit,
        agent: context.agent.name,
    });

    // Try advanced full-text search first
    const advancedResult = conversationRegistry.searchAdvanced(
        { query, filters },
        limit
    );

    if (advancedResult.success) {
        // Advanced search succeeded
        if (advancedResult.results.length > 0) {
            logger.info("✅ Advanced conversation search complete", {
                query,
                found: advancedResult.results.length,
                agent: context.agent.name,
            });

            return {
                success: true,
                conversations: advancedResult.results.map((result) => ({
                    id: result.conversationId,
                    title: result.title,
                    messageCount: result.messageCount,
                    createdAt: result.createdAt,
                    lastActivity: result.lastActivity,
                    matches: result.matches,
                })),
                total: advancedResult.results.length,
                query,
                searchType: "full-text",
            };
        }

        // Advanced search succeeded but no results - try legacy search too
        const legacyResults = legacyTitleSearch(query, limit);

        if (legacyResults.length > 0) {
            logger.info("✅ Fallback title search returned results", {
                query,
                found: legacyResults.length,
                agent: context.agent.name,
            });

            return {
                success: true,
                conversations: legacyResults,
                total: legacyResults.length,
                query,
                searchType: "title-only",
                warning: "Full-text search found no results; showing title-only matches",
            };
        }

        // No results from either search
        return {
            success: true,
            conversations: [],
            total: 0,
            query,
            searchType: "full-text",
        };
    }

    // Advanced search failed - report the error but try fallback
    logger.warn("⚠️ Advanced search failed, falling back to title search", {
        error: advancedResult.error,
        query,
        agent: context.agent.name,
    });

    const legacyResults = legacyTitleSearch(query, limit);

    logger.info("✅ Fallback conversation search complete", {
        query,
        found: legacyResults.length,
        agent: context.agent.name,
    });

    return {
        success: true,
        conversations: legacyResults,
        total: legacyResults.length,
        query,
        searchType: "title-only",
        warning: `Full-text search failed: ${advancedResult.error}. Showing title-only results.`,
    };
}

export function createConversationSearchTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Search conversations by title and message content. Returns matching conversations with summary information including ID, title, message count, timestamps, and matching snippets. Supports filtering by agents (exact match) and date range.",

        inputSchema: conversationSearchSchema,

        execute: async (input: ConversationSearchInput) => {
            return await executeConversationSearch(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ query, filters, limit }: ConversationSearchInput) => {
            const parts = [`Searching conversations for "${query}"`];
            if (filters?.agents?.length) {
                parts.push(`agents: ${filters.agents.join(", ")}`);
            }
            if (filters?.since || filters?.after) {
                parts.push(`since: ${filters.since || filters.after}`);
            }
            if (limit && limit !== 20) {
                parts.push(`limit: ${limit}`);
            }
            return parts.join(" | ");
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
