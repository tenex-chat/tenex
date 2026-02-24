import type { ToolExecutionContext } from "@/tools/types";
import { ALPHA_BUG_HASHTAG, TENEX_BACKEND_PROJECT_ATAG } from "@/constants";
import { llmServiceFactory } from "@/llm";
import { getNDK } from "@/nostr";
import { collectEvents } from "@/nostr/collectEvents";
import { config } from "@/services/ConfigService";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { tool } from "ai";
import { z } from "zod";

const bugListSchema = z.object({}).describe("No parameters required");

interface BugSummary {
    id: string;
    title: string;
    summary: string;
    status: "open" | "investigating" | "fixed" | "wontfix";
    createdAt: number;
    replyCount: number;
}

interface BugListOutput {
    bugs: BugSummary[];
    count: number;
}

async function summarizeBugConversation(
    bugEvent: NDKEvent,
    replies: NDKEvent[]
): Promise<{ summary: string; status: "open" | "investigating" | "fixed" | "wontfix" }> {
    // Build flattened conversation content
    const allEvents = [bugEvent, ...replies].sort(
        (a, b) => (a.created_at || 0) - (b.created_at || 0)
    );

    const conversationContent = allEvents
        .map((event) => {
            const timestamp = event.created_at
                ? new Date(event.created_at * 1000).toISOString()
                : "unknown";
            return `[${timestamp}]: ${event.content}`;
        })
        .join("\n\n");

    // Get LLM configuration (prefer 'metadata' config, fallback to default)
    // Use getLLMConfig to resolve meta models automatically
    await config.loadConfig();
    let metadataConfig;
    try {
        metadataConfig = config.getLLMConfig("metadata");
    } catch {
        // 'metadata' config doesn't exist, try default
        try {
            metadataConfig = config.getLLMConfig();
        } catch {
            // No LLM configured at all
            metadataConfig = undefined;
        }
    }

    if (!metadataConfig) {
        // Fallback if no LLM configured
        return {
            summary: bugEvent.content.substring(0, 200) + (bugEvent.content.length > 200 ? "..." : ""),
            status: "open",
        };
    }

    // Create LLM service
    const llmService = llmServiceFactory.createService(metadataConfig, {
        agentName: "bug-summarizer",
        sessionId: `bug-summarizer-${bugEvent.id}`,
    });

    try {
        const { object } = await llmService.generateObject(
            [
                {
                    role: "system",
                    content: `You are analyzing a bug report conversation from the TENEX alpha testing system.
Generate a concise summary and determine the current status of the bug.

Status definitions:
- "open": Bug is reported but not being worked on
- "investigating": Someone is actively looking into the bug
- "fixed": The bug has been resolved
- "wontfix": The bug will not be addressed (not a bug, won't implement, etc.)

Base your status determination on the conversation content. If there's no clear indication, default to "open".`,
                },
                {
                    role: "user",
                    content: `Bug report conversation:\n\n${conversationContent}`,
                },
            ],
            z.object({
                summary: z.string().describe("Brief 1-2 sentence summary of the bug and its current state"),
                status: z
                    .enum(["open", "investigating", "fixed", "wontfix"])
                    .describe("Current status of the bug"),
            })
        );

        return object;
    } catch (error) {
        logger.warn("Failed to generate AI summary for bug, using fallback", { error, bugId: bugEvent.id });
        return {
            summary: bugEvent.content.substring(0, 200) + (bugEvent.content.length > 200 ? "..." : ""),
            status: "open",
        };
    }
}

async function executeBugList(_context: ToolExecutionContext): Promise<BugListOutput> {
    const ndk = getNDK();
    if (!ndk) {
        throw new Error("NDK instance not available");
    }

    logger.info("Fetching alpha bug reports", {
        filter: { "#a": [TENEX_BACKEND_PROJECT_ATAG], "#t": [ALPHA_BUG_HASHTAG] },
    });

    const bugEvents = await collectEvents(ndk, {
        kinds: [1],
        "#a": [TENEX_BACKEND_PROJECT_ATAG],
        "#t": [ALPHA_BUG_HASHTAG],
    });

    if (bugEvents.length === 0) {
        return { bugs: [], count: 0 };
    }

    // Process all bugs in parallel for better performance
    const bugs = await Promise.all(
        bugEvents.map(async (bugEvent) => {
            const replies = await collectEvents(ndk, {
                kinds: [1],
                "#e": [bugEvent.id],
                "#a": [TENEX_BACKEND_PROJECT_ATAG],
            });

            // Get title from tag or content
            const title =
                bugEvent.tagValue("title") || bugEvent.content.substring(0, 50).split("\n")[0] || "Untitled Bug";

            // Generate AI summary
            const { summary, status } = await summarizeBugConversation(bugEvent, replies);

            return {
                id: bugEvent.id,
                title,
                summary,
                status,
                createdAt: bugEvent.created_at || 0,
                replyCount: replies.length,
            };
        })
    );

    // Sort by creation time (newest first)
    bugs.sort((a, b) => b.createdAt - a.createdAt);

    logger.info("Bug list fetched", { count: bugs.length });

    return { bugs, count: bugs.length };
}

export function createBugListTool(context: ToolExecutionContext): AISdkTool {
    const coreTool = tool({
        description:
            "List all alpha bug reports for TENEX. Returns bug IDs, titles, AI-generated summaries, and current status. Use this to check if a bug has already been reported before creating a new one.",
        inputSchema: bugListSchema,
        execute: async () => {
            return await executeBugList(context);
        },
    }) as AISdkTool;

    coreTool.getHumanReadableContent = () => "Listing alpha bug reports";

    return coreTool;
}
