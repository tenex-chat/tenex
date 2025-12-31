/**
 * Web Fetch Tool
 *
 * Fetches content from a specified URL and processes it using an AI model.
 * Converts HTML to markdown and optionally summarizes using a small, fast model.
 *
 * Features:
 * - HTTPS upgrade for HTTP URLs
 * - HTML to markdown conversion
 * - 15-minute self-cleaning cache
 * - Redirect handling with informative response
 * - Content summarization for large pages
 */

import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

// ============================================================================
// Types and Constants
// ============================================================================

interface CacheEntry {
    content: string;
    timestamp: number;
    url: string;
}

// Cache TTL: 15 minutes in milliseconds
const CACHE_TTL_MS = 15 * 60 * 1000;

// Maximum content size before summarization (characters)
const MAX_CONTENT_SIZE = 100_000;

// Self-cleaning interval: check every 5 minutes
const CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

// ============================================================================
// Cache Implementation
// ============================================================================

/**
 * URL content cache with automatic cleanup
 */
class WebFetchCache {
    private cache = new Map<string, CacheEntry>();
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    constructor() {
        this.startCleanupTimer();
    }

    /**
     * Get cached content for a URL
     */
    get(url: string): string | null {
        const entry = this.cache.get(url);
        if (!entry) return null;

        // Check if entry is still valid
        if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
            this.cache.delete(url);
            return null;
        }

        logger.debug(`Cache hit for URL: ${url}`);
        return entry.content;
    }

    /**
     * Store content in cache
     */
    set(url: string, content: string): void {
        this.cache.set(url, {
            content,
            timestamp: Date.now(),
            url,
        });
        logger.debug(`Cached content for URL: ${url}`);
    }

    /**
     * Clear expired entries
     */
    cleanup(): void {
        const now = Date.now();
        let cleanedCount = 0;

        for (const [url, entry] of this.cache.entries()) {
            if (now - entry.timestamp > CACHE_TTL_MS) {
                this.cache.delete(url);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            logger.debug(`Cleaned up ${cleanedCount} expired cache entries`);
        }
    }

    /**
     * Start the automatic cleanup timer
     */
    private startCleanupTimer(): void {
        if (this.cleanupTimer) return;

        this.cleanupTimer = setInterval(() => {
            this.cleanup();
        }, CACHE_CLEANUP_INTERVAL_MS);

        // Don't prevent process exit
        if (this.cleanupTimer.unref) {
            this.cleanupTimer.unref();
        }
    }

    /**
     * Stop the cleanup timer
     */
    destroy(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        this.cache.clear();
    }
}

// Singleton cache instance
const urlCache = new WebFetchCache();

// ============================================================================
// HTML to Markdown Conversion
// ============================================================================

/**
 * Convert HTML content to markdown
 * Simple but effective conversion without external dependencies
 */
function htmlToMarkdown(html: string): string {
    let text = html;

    // Remove script and style tags with their content
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");

    // Remove HTML comments
    text = text.replace(/<!--[\s\S]*?-->/g, "");

    // Handle headings (h1-h6)
    text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n\n");
    text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n\n");
    text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n\n");
    text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n\n");
    text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n\n");
    text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n\n");

    // Handle links: <a href="url">text</a> -> [text](url)
    text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

    // Handle images: <img src="url" alt="text"> -> ![text](url)
    text = text.replace(/<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, "![$2]($1)");
    text = text.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*\/?>/gi, "![$1]($2)");
    text = text.replace(/<img[^>]*src=["']([^"']*)["'][^>]*\/?>/gi, "![]($1)");

    // Handle bold: <strong> or <b>
    text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");

    // Handle italic: <em> or <i>
    text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");

    // Handle code blocks: <pre><code>
    text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n");
    text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");

    // Handle inline code: <code>
    text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

    // Handle blockquotes
    text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
        const lines = content.trim().split("\n");
        return "\n" + lines.map((line: string) => "> " + line.trim()).join("\n") + "\n";
    });

    // Handle unordered lists
    text = text.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, content) => {
        return "\n" + content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n") + "\n";
    });

    // Handle ordered lists
    let olCounter = 0;
    text = text.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content) => {
        olCounter = 0;
        return (
            "\n" +
            content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, () => {
                olCounter++;
                return `${olCounter}. ` + "$1\n";
            }) +
            "\n"
        );
    });

    // Handle list items outside of ul/ol context
    text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");

    // Handle paragraphs
    text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n\n");

    // Handle line breaks
    text = text.replace(/<br\s*\/?>/gi, "\n");

    // Handle horizontal rules
    text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

    // Handle tables (basic support)
    text = text.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableContent) => {
        let result = "\n";
        const rows = tableContent.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];

        rows.forEach((row: string, index: number) => {
            const cells = row.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
            const cellContents = cells.map((cell: string) =>
                cell.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/i, "$1").trim()
            );

            if (cellContents.length > 0) {
                result += "| " + cellContents.join(" | ") + " |\n";

                // Add header separator after first row
                if (index === 0) {
                    result += "|" + cellContents.map(() => " --- ").join("|") + "|\n";
                }
            }
        });

        return result + "\n";
    });

    // Remove remaining HTML tags
    text = text.replace(/<[^>]+>/g, "");

    // Decode common HTML entities
    text = text
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&copy;/gi, "©")
        .replace(/&reg;/gi, "®")
        .replace(/&trade;/gi, "™")
        .replace(/&mdash;/gi, "—")
        .replace(/&ndash;/gi, "–")
        .replace(/&hellip;/gi, "…")
        .replace(/&#(\d+);/gi, (_, num) => String.fromCharCode(parseInt(num, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

    // Normalize whitespace
    text = text
        .replace(/\t/g, "    ") // Replace tabs with spaces
        .replace(/  +/g, " ") // Collapse multiple spaces
        .replace(/\n\s*\n\s*\n/g, "\n\n") // Collapse multiple blank lines
        .replace(/^\s+/gm, "") // Remove leading whitespace from lines
        .trim();

    return text;
}

// ============================================================================
// URL Validation and Processing
// ============================================================================

/**
 * Validate and normalize URL, upgrading HTTP to HTTPS
 */
function normalizeUrl(urlString: string): URL {
    let url: URL;

    try {
        url = new URL(urlString);
    } catch {
        throw new Error(`Invalid URL: ${urlString}`);
    }

    // Upgrade HTTP to HTTPS
    if (url.protocol === "http:") {
        url.protocol = "https:";
        logger.debug(`Upgraded HTTP to HTTPS: ${url.toString()}`);
    }

    // Only allow HTTP(S) protocols
    if (url.protocol !== "https:") {
        throw new Error(`Unsupported protocol: ${url.protocol}. Only HTTP/HTTPS URLs are supported.`);
    }

    return url;
}

// ============================================================================
// Core Fetch Implementation
// ============================================================================

interface FetchResult {
    content: string;
    finalUrl: string;
    redirected: boolean;
    redirectHost?: string;
    contentType: string;
}

/**
 * Fetch content from URL with redirect handling
 */
async function fetchUrl(urlString: string): Promise<FetchResult> {
    const url = normalizeUrl(urlString);
    const originalHost = url.host;

    // Check cache first
    const cachedContent = urlCache.get(url.toString());
    if (cachedContent) {
        return {
            content: cachedContent,
            finalUrl: url.toString(),
            redirected: false,
            contentType: "text/html", // Assume HTML for cached content
        };
    }

    logger.debug(`Fetching URL: ${url.toString()}`);

    const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
            "User-Agent": "TENEX-WebFetch/1.0 (https://github.com/tenex)",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
            "Accept-Language": "en-US,en;q=0.5",
        },
        redirect: "follow",
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const finalUrl = new URL(response.url);
    const redirected = finalUrl.host !== originalHost;
    const contentType = response.headers.get("content-type") || "text/html";

    // Read response body
    const rawContent = await response.text();

    // Convert to markdown if HTML
    let content: string;
    if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
        content = htmlToMarkdown(rawContent);
    } else if (contentType.includes("text/plain") || contentType.includes("text/markdown")) {
        content = rawContent;
    } else if (contentType.includes("application/json")) {
        // Pretty-print JSON
        try {
            const parsed = JSON.parse(rawContent);
            content = "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
        } catch {
            content = rawContent;
        }
    } else {
        // For other content types, return as-is
        content = rawContent;
    }

    // Cache the content (even if redirected to a different host)
    urlCache.set(url.toString(), content);

    return {
        content,
        finalUrl: finalUrl.toString(),
        redirected,
        redirectHost: redirected ? finalUrl.host : undefined,
        contentType,
    };
}

// ============================================================================
// Tool Schema and Implementation
// ============================================================================

const webFetchSchema = z.object({
    url: z
        .string()
        .url()
        .describe("The URL to fetch content from. HTTP URLs will be upgraded to HTTPS."),
    prompt: z
        .string()
        .describe("The prompt to run on the fetched content. Describes what information to extract."),
});

type WebFetchInput = z.infer<typeof webFetchSchema>;

/**
 * Execute the web fetch operation
 */
async function executeWebFetch(
    input: WebFetchInput,
    _context: ExecutionContext
): Promise<string> {
    const { url, prompt } = input;

    try {
        // Fetch the URL content
        const result = await fetchUrl(url);

        // If redirected to a different host, inform the caller
        if (result.redirected && result.redirectHost) {
            return (
                `The URL redirected to a different host: ${result.redirectHost}\n\n` +
                `To fetch the content, please make a new request with this URL:\n` +
                `REDIRECT_URL: ${result.finalUrl}\n\n` +
                `Note: The content at the redirect destination was not automatically fetched ` +
                `because it's on a different host than originally requested.`
            );
        }

        // Truncate content if too large
        let content = result.content;
        let truncated = false;
        if (content.length > MAX_CONTENT_SIZE) {
            content = content.substring(0, MAX_CONTENT_SIZE);
            truncated = true;
        }

        // Format the response with the content and prompt context
        let response = "";

        if (truncated) {
            response += `Note: Content was truncated to ${MAX_CONTENT_SIZE} characters.\n\n`;
        }

        response += `## Fetched Content from ${result.finalUrl}\n\n`;
        response += `Content-Type: ${result.contentType}\n\n`;
        response += `---\n\n`;
        response += content;
        response += `\n\n---\n\n`;
        response += `## User Request\n\n${prompt}`;

        return response;
    } catch (error) {
        throw new Error(`Failed to fetch URL "${url}": ${formatAnyError(error)}`);
    }
}

// ============================================================================
// Tool Export
// ============================================================================

/**
 * Create the web_fetch AI SDK tool
 */
export function createWebFetchTool(context: ExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Fetches content from a specified URL and returns it for analysis. " +
            "Converts HTML to markdown, caches results for 15 minutes, and automatically " +
            "upgrades HTTP to HTTPS. Use this to retrieve and analyze web content, " +
            "documentation, API references, or any publicly accessible web page. " +
            "When a URL redirects to a different host, you'll receive the redirect URL " +
            "and should make a new request with it.",

        inputSchema: webFetchSchema,

        execute: async (input: WebFetchInput) => {
            return await executeWebFetch(input, context);
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ url, prompt }: WebFetchInput) => {
            return `Fetching ${url}: ${prompt.substring(0, 50)}${prompt.length > 50 ? "..." : ""}`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}

/**
 * Export cache for testing purposes
 */
export const _testExports = {
    urlCache,
    htmlToMarkdown,
    normalizeUrl,
    fetchUrl,
};
