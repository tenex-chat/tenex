/**
 * Web Fetch Tool
 *
 * Fetches content from a URL and returns it for processing.
 * HTML is converted to markdown, other content types returned as-is.
 */

import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { tool } from "ai";
import { z } from "zod";

const htmlToMarkdown = new NodeHtmlMarkdown();

/**
 * Validate URL - allows both HTTP and HTTPS
 */
function validateUrl(urlString: string): URL {
    let url: URL;

    try {
        url = new URL(urlString);
    } catch {
        throw new Error(`Invalid URL: ${urlString}`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`Unsupported protocol: ${url.protocol}. Only HTTP/HTTPS URLs are supported.`);
    }

    return url;
}

interface FetchResult {
    content: string;
    finalUrl: string;
    contentType: string;
}

/**
 * Fetch content from URL
 */
async function fetchUrl(urlString: string): Promise<FetchResult> {
    const url = validateUrl(urlString);

    logger.debug(`Fetching URL: ${url.toString()}`);

    const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
            "User-Agent": "TENEX-WebFetch/1.0 (https://github.com/tenex)",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.6",
            "Accept-Language": "en-US,en;q=0.5",
        },
        redirect: "follow",
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const finalUrl = response.url;
    const contentType = response.headers.get("content-type") || "text/plain";
    const rawContent = await response.text();

    // Convert HTML to markdown, leave other content types as-is
    let content: string;
    if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
        content = htmlToMarkdown.translate(rawContent);
    } else {
        content = rawContent;
    }

    return {
        content,
        finalUrl,
        contentType,
    };
}

const webFetchSchema = z.object({
    url: z.string().describe("The URL to fetch content from"),
});

type WebFetchInput = z.infer<typeof webFetchSchema>;

async function executeWebFetch(input: WebFetchInput): Promise<string> {
    const { url } = input;

    try {
        const result = await fetchUrl(url);

        return (
            `Content-Type: ${result.contentType}\n` +
            `URL: ${result.finalUrl}\n\n` +
            result.content
        );
    } catch (error) {
        throw new Error(`Failed to fetch URL "${url}": ${formatAnyError(error)}`);
    }
}

/**
 * Create the web_fetch AI SDK tool
 */
export function createWebFetchTool(_context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Fetches content from a URL. HTML is converted to markdown, " +
            "JSON and other content types are returned as-is. " +
            "Supports both HTTP and HTTPS URLs including localhost.",

        inputSchema: webFetchSchema,

        execute: async (input: WebFetchInput) => {
            return await executeWebFetch(input);
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ url }: WebFetchInput) => {
            return `Fetching ${url}`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}
