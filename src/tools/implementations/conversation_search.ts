import type { ToolExecutionContext } from "@/tools/types";
import { conversationRegistry } from "@/conversations/ConversationRegistry";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { MessageMatch } from "@/conversations/search";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";
import {
    getConversationEmbeddingService,
    type SemanticSearchResult,
} from "@/conversations/search/embeddings";

/**
 * Search mode for conversation search
 * - "keyword": Traditional title-based substring matching (fast, exact)
 * - "semantic": Natural language semantic search using embeddings (slower, understands meaning)
 * - "hybrid": Combines both approaches, semantic results first, then keyword fallback
 * - "full-text": Full-text search across all message content (advanced)
 */
const SearchMode = z.enum(["keyword", "semantic", "hybrid", "full-text"]).describe(
    "Search mode: 'keyword' (fast title matching), 'semantic' (natural language), 'hybrid' (both), or 'full-text' (all messages)"
);

const conversationSearchSchema = z.object({
    query: z.string().describe(
        "Search query. For keyword mode: matches against conversation titles. " +
        "For semantic mode: natural language query like 'conversations about debugging memory issues'. " +
        "For full-text mode: matches against all message content and titles."
    ),
    mode: SearchMode.optional().describe(
        "Search mode: 'keyword' (default, fast), 'semantic' (natural language), 'hybrid' (both), or 'full-text' (comprehensive)"
    ),
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
    minScore: z
        .number()
        .optional()
        .describe("Minimum relevance score for semantic results (0-1). Defaults to 0.3."),
    projectId: z
        .string()
        .optional()
        .describe("Filter by project ID. Use 'ALL' for all projects."),
});

type ConversationSearchInput = z.infer<typeof conversationSearchSchema>;

interface ConversationSearchResult {
    id: string;
    projectId?: string;
    title?: string;
    summary?: string;
    messageCount: number;
    createdAt?: number;
    lastActivity?: number;
    matches?: MessageMatch[];
    relevanceScore?: number; // Only present for semantic/hybrid results
}

interface ConversationSearchOutput {
    success: boolean;
    conversations: ConversationSearchResult[];
    total: number;
    query: string;
    mode: string;
    searchType?: "full-text" | "title-only" | "semantic" | "hybrid";
    semanticAvailable: boolean;
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

/**
 * Perform keyword-based search on conversation titles
 */
function keywordSearch(query: string, limit: number): ConversationSearchResult[] {
    return legacyTitleSearch(query, limit);
}

/**
 * Perform semantic search using embeddings
 */
async function semanticSearch(
    query: string,
    limit: number,
    minScore: number,
    projectId?: string
): Promise<ConversationSearchResult[]> {
    const conversationEmbeddingService = getConversationEmbeddingService();
    try {
        const results = await conversationEmbeddingService.semanticSearch(query, {
            limit,
            minScore,
            projectId,
        });
        return results.map((result: SemanticSearchResult) => ({
            id: result.conversationId,
            projectId: result.projectId,
            title: result.title,
            summary: result.summary,
            messageCount: result.messageCount,
            createdAt: result.createdAt,
            lastActivity: result.lastActivity,
            relevanceScore: result.relevanceScore,
        }));
    } catch (error) {
        logger.error("Semantic search failed, falling back to empty results", { error });
        return [];
    }
}

/**
 * Perform hybrid search: semantic first, then keyword fallback
 * Deduplicates results by conversation ID
 */
async function hybridSearch(
    query: string,
    limit: number,
    minScore: number,
    projectId?: string
): Promise<ConversationSearchResult[]> {
    const seen = new Set<string>();
    const combined: ConversationSearchResult[] = [];

    // First: semantic results (higher quality matches)
    const semanticResults = await semanticSearch(query, limit, minScore, projectId);
    for (const result of semanticResults) {
        if (!seen.has(result.id)) {
            seen.add(result.id);
            combined.push(result);
        }
    }

    // Second: keyword results to fill up remaining slots
    if (combined.length < limit) {
        const keywordResults = keywordSearch(query, limit);
        for (const result of keywordResults) {
            if (!seen.has(result.id) && combined.length < limit) {
                seen.add(result.id);
                combined.push(result);
            }
        }
    }

    return combined.slice(0, limit);
}

/**
 * Perform full-text search across all messages
 */
async function fullTextSearch(
    query: string,
    filters: ConversationSearchInput["filters"],
    limit: number
): Promise<{ results: ConversationSearchResult[]; searchType: "full-text" | "title-only"; error?: string }> {
    const advancedResult = conversationRegistry.searchAdvanced({ query, filters }, limit);

    if (advancedResult.success) {
        if (advancedResult.results.length > 0) {
            return {
                searchType: "full-text",
                results: advancedResult.results.map((result) => ({
                    id: result.conversationId,
                    title: result.title,
                    messageCount: result.messageCount,
                    createdAt: result.createdAt,
                    lastActivity: result.lastActivity,
                    matches: result.matches,
                })),
            };
        }

        // Advanced search succeeded but no results - try legacy search too
        const legacyResults = legacyTitleSearch(query, limit);
        if (legacyResults.length > 0) {
            return {
                searchType: "title-only",
                results: legacyResults,
            };
        }

        // No results from either search
        return {
            searchType: "full-text",
            results: [],
        };
    }

    // Advanced search failed - try fallback
    logger.warn("⚠️ Advanced search failed, falling back to title search", {
        error: advancedResult.error,
        query,
    });

    const legacyResults = legacyTitleSearch(query, limit);

    return {
        searchType: "title-only",
        results: legacyResults,
        error: advancedResult.error,
    };
}

/**
 * Check if semantic search is available
 */
async function isSemanticSearchAvailable(): Promise<boolean> {
    try {
        const conversationEmbeddingService = getConversationEmbeddingService();
        return await conversationEmbeddingService.hasIndexedConversations();
    } catch {
        return false;
    }
}

async function executeConversationSearch(
    input: ConversationSearchInput,
    context: ToolExecutionContext
): Promise<ConversationSearchOutput> {
    const { query, mode = "keyword", filters, limit = 20, minScore = 0.3, projectId } = input;

    logger.info("🔍 Searching conversations", {
        query,
        mode,
        filters,
        limit,
        minScore,
        projectId,
        agent: context.agent.name,
    });

    // Check semantic availability
    const semanticAvailable = await isSemanticSearchAvailable();

    // Determine effective mode
    let effectiveMode = mode;
    if ((mode === "semantic" || mode === "hybrid") && !semanticAvailable) {
        logger.info("Semantic search not available, falling back to keyword search");
        effectiveMode = "keyword";
    }

    let conversations: ConversationSearchResult[];
    let searchType: "full-text" | "title-only" | "semantic" | "hybrid";
    let warning: string | undefined;

    switch (effectiveMode) {
        case "semantic":
            conversations = await semanticSearch(query, limit, minScore, projectId);
            searchType = "semantic";
            break;

        case "hybrid":
            conversations = await hybridSearch(query, limit, minScore, projectId);
            searchType = "hybrid";
            break;

        case "full-text": {
            const fullTextResult = await fullTextSearch(query, filters, limit);
            conversations = fullTextResult.results;
            searchType = fullTextResult.searchType;
            if (fullTextResult.error) {
                warning = `Full-text search failed: ${fullTextResult.error}. Showing ${fullTextResult.searchType} results.`;
            } else if (fullTextResult.searchType === "title-only" && fullTextResult.results.length > 0) {
                warning = "Full-text search found no results; showing title-only matches";
            }
            break;
        }

        case "keyword":
        default:
            conversations = keywordSearch(query, limit);
            searchType = "full-text";
            break;
    }

    logger.info("✅ Conversation search complete", {
        query,
        mode: effectiveMode,
        found: conversations.length,
        semanticAvailable,
        agent: context.agent.name,
    });

    return {
        success: true,
        conversations,
        total: conversations.length,
        query,
        mode: effectiveMode,
        searchType,
        semanticAvailable,
        warning,
    };
}

export function createConversationSearchTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Search conversations with multiple search modes. Returns matching conversations with summary information including ID, title, message count, and timestamps. " +
            "Supports four search modes: 'keyword' (fast title matching), 'semantic' (natural language understanding), 'hybrid' (both), and 'full-text' (comprehensive message search). " +
            "Use semantic or hybrid mode for natural language queries that understand meaning.",

        inputSchema: conversationSearchSchema,

        execute: async (input: ConversationSearchInput) => {
            return await executeConversationSearch(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ query, mode, filters, limit }: ConversationSearchInput) => {
            const parts = [`Searching conversations for "${query}"`];
            const modeStr = mode || "keyword";
            parts.push(`mode=${modeStr}`);
            if (filters?.agents?.length) {
                parts.push(`agents: ${filters.agents.join(", ")}`);
            }
            if (filters?.since || filters?.after) {
                parts.push(`since: ${filters.since || filters.after}`);
            }
            if (limit && limit !== 20) {
                parts.push(`limit: ${limit}`);
            }
            return parts.join(", ");
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
