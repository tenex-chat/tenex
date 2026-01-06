/**
 * Web Search Tool
 *
 * Searches the web using DuckDuckGo without requiring API keys.
 * Returns search results with titles, URLs, and descriptions.
 */

import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { search, SafeSearchType, SearchTimeType } from "duck-duck-scrape";
import { tool } from "ai";
import { z } from "zod";

const webSearchSchema = z.object({
    query: z.string().min(1).max(500).describe("The search query"),
    max_results: z
        .number()
        .min(1)
        .max(25)
        .default(10)
        .describe("Maximum number of results to return (1-25)"),
    safe_search: z
        .enum(["off", "moderate", "strict"])
        .default("moderate")
        .describe("Safe search level: off, moderate, or strict"),
    time: z
        .enum(["d", "w", "m", "y"])
        .optional()
        .describe("Time filter: d (day), w (week), m (month), y (year)"),
});

type WebSearchInput = z.infer<typeof webSearchSchema>;

interface SearchResultItem {
    title: string;
    url: string;
    description: string;
}

interface WebSearchOutput {
    query: string;
    resultsCount: number;
    results: SearchResultItem[];
}

function mapSafeSearch(level: "off" | "moderate" | "strict"): SafeSearchType {
    switch (level) {
        case "off":
            return SafeSearchType.OFF;
        case "strict":
            return SafeSearchType.STRICT;
        default:
            return SafeSearchType.MODERATE;
    }
}

function mapTimeFilter(time?: "d" | "w" | "m" | "y"): SearchTimeType | undefined {
    if (!time) return undefined;
    switch (time) {
        case "d":
            return SearchTimeType.DAY;
        case "w":
            return SearchTimeType.WEEK;
        case "m":
            return SearchTimeType.MONTH;
        case "y":
            return SearchTimeType.YEAR;
    }
}

async function executeWebSearch(input: WebSearchInput): Promise<WebSearchOutput> {
    const { query, max_results, safe_search, time } = input;

    logger.debug(`Web search: "${query}" (max: ${max_results}, safe: ${safe_search})`);

    const searchResults = await search(query, {
        safeSearch: mapSafeSearch(safe_search),
        time: mapTimeFilter(time),
    });

    if (searchResults.noResults) {
        return {
            query,
            resultsCount: 0,
            results: [],
        };
    }

    const results: SearchResultItem[] = searchResults.results
        .slice(0, max_results)
        .map((r) => ({
            title: r.title,
            url: r.url,
            description: r.description || "",
        }));

    return {
        query,
        resultsCount: results.length,
        results,
    };
}

export function createWebSearchTool(_context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Search the web using DuckDuckGo. Returns search results with titles, URLs, and descriptions. " +
            "No API key required. Use for finding current information, documentation, articles, or any web content. " +
            "For site-specific searches, include 'site:example.com' in your query.",

        inputSchema: webSearchSchema,

        execute: async (input: WebSearchInput) => {
            try {
                return await executeWebSearch(input);
            } catch (error) {
                const errorMsg = formatAnyError(error);
                logger.error("Web search failed", { error, query: input.query });

                // Provide a clearer message for rate limiting
                if (errorMsg.includes("anomaly") || errorMsg.includes("too quickly")) {
                    throw new Error(
                        "DuckDuckGo rate limited the request. Wait a moment and try again, or try a different query."
                    );
                }

                throw new Error(`Web search failed: ${errorMsg}`);
            }
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ query, max_results }: WebSearchInput) => {
            return `Searching web for "${query}" (max ${max_results || 10} results)`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}
