/**
 * Web Search Tool
 *
 * Searches the web using either:
 * 1. A configured LLM model (via TenexLLMs.search) - preferred when available
 * 2. DuckDuckGo as a fallback
 *
 * When using an LLM, the model performs the search using its internal knowledge
 * and web access capabilities.
 */

import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { search, SafeSearchType, SearchTimeType } from "duck-duck-scrape";
import { config as configService } from "@/services/ConfigService";
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
    /** The search backend used: "llm" if using configured search model, "duckduckgo" for fallback */
    source: "llm" | "duckduckgo";
}

/**
 * Schema for LLM search response
 */
const llmSearchResponseSchema = z.object({
    query: z.string().describe("The search query that was processed"),
    results: z.array(z.object({
        title: z.string().describe("Title of the search result"),
        url: z.string().describe("URL of the search result"),
        snippet: z.string().describe("Brief description or snippet of the result"),
    })).describe("Array of search results"),
});

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

/**
 * Execute search using a configured LLM model.
 *
 * NOTE: When using LLM search, the `safe_search` and `time` parameters are not applied.
 * These filters are only supported by the DuckDuckGo backend. LLM search relies on the
 * model's training data and capabilities, which may not respect time-based filtering.
 * This is a known limitation that may be addressed in future versions.
 */
async function executeLLMSearch(input: WebSearchInput, searchConfigName: string): Promise<WebSearchOutput> {
    const { query, max_results } = input;

    logger.debug(`LLM search: "${query}" (max: ${max_results}) using config: ${searchConfigName}`);

    const llmService = configService.createLLMService(searchConfigName);

    const systemPrompt = `You are a web search tool. You MUST respond ONLY with valid JSON matching the required schema.
Return search results for the given query. Provide accurate, relevant results with real URLs when possible.
If you cannot find real URLs, provide plausible examples with clearly marked placeholder URLs.`;

    const userPrompt = `Search for: "${query}"
Return up to ${max_results} results.
Each result must have a title, url, and snippet (brief description).`;

    const result = await llmService.generateObject(
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ],
        llmSearchResponseSchema
    );

    const searchResults = result.object;

    // Map LLM response to our output format
    const results: SearchResultItem[] = searchResults.results
        .slice(0, max_results)
        .map((r) => ({
            title: r.title,
            url: r.url,
            description: r.snippet,
        }));

    return {
        query,
        resultsCount: results.length,
        results,
        source: "llm",
    };
}

/**
 * Execute search using DuckDuckGo (fallback)
 */
async function executeDuckDuckGoSearch(input: WebSearchInput): Promise<WebSearchOutput> {
    const { query, max_results, safe_search, time } = input;

    logger.debug(`DuckDuckGo search: "${query}" (max: ${max_results}, safe: ${safe_search})`);

    const searchResults = await search(query, {
        safeSearch: mapSafeSearch(safe_search),
        time: mapTimeFilter(time),
    });

    if (searchResults.noResults) {
        return {
            query,
            resultsCount: 0,
            results: [],
            source: "duckduckgo",
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
        source: "duckduckgo",
    };
}

/**
 * Get the configured search model name if available.
 * Uses the typed accessor from ConfigService.
 */
function getSearchModelConfig(): string | undefined {
    try {
        return configService.getSearchModelName();
    } catch {
        return undefined;
    }
}

async function executeWebSearch(input: WebSearchInput): Promise<WebSearchOutput> {
    // Check if we have a configured search model
    const searchConfigName = getSearchModelConfig();

    if (searchConfigName) {
        try {
            logger.info(`Using LLM search with config: ${searchConfigName}`);
            return await executeLLMSearch(input, searchConfigName);
        } catch (error) {
            // Log the error and fall back to DuckDuckGo
            logger.warn("LLM search failed, falling back to DuckDuckGo", {
                error: formatAnyError(error),
                query: input.query,
            });
        }
    }

    // Fall back to DuckDuckGo
    return await executeDuckDuckGoSearch(input);
}

export function createWebSearchTool(_context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Search the web for information. Returns search results with titles, URLs, and descriptions. " +
            "Use for finding current information, documentation, articles, or any web content. " +
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
                        "Search rate limited. Wait a moment and try again, or try a different query.",
                        { cause: error }
                    );
                }

                throw new Error(`Web search failed: ${errorMsg}`, { cause: error });
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
