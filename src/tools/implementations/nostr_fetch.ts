/**
 * Nostr Fetch Tool
 *
 * Fetches any nostr event by ID and returns formatted or raw output.
 * Supports various ID formats: nevent, note, naddr, hex, with or without "nostr:" prefix.
 */

import type { ToolExecutionContext } from "@/tools/types";
import { getNDK } from "@/nostr";
import { getPubkeyService } from "@/services/PubkeyService";
import type { AISdkTool } from "@/tools/types";
import { createExpectedError, isExpectedNotFoundError } from "@/tools/utils";
import { logger } from "@/utils/logger";
import { parseNostrEvent } from "@/utils/nostr-entity-parser";
import { tool } from "ai";
import { z } from "zod";

/**
 * Schema for nostr_fetch tool input
 */
const nostrFetchSchema = z.object({
    eventId: z
        .string()
        .describe(
            "The event ID to fetch. Supports nevent, note, naddr, hex format, with or without 'nostr:' prefix"
        ),
    format: z
        .enum(["raw", "display"])
        .default("display")
        .describe(
            "Output format: 'raw' returns the raw event JSON, 'display' returns human-readable format"
        ),
});

type NostrFetchInput = z.infer<typeof nostrFetchSchema>;

/**
 * Format a tag for display
 */
function formatTag(tag: string[]): string {
    if (tag.length === 0) return "";
    if (tag.length === 1) return tag[0];
    return `${tag[0]}=${tag.slice(1).join(",")}`;
}

/**
 * Format timestamp to human-readable string
 */
function formatTimestamp(unixTimestamp: number): string {
    const date = new Date(unixTimestamp * 1000);
    return date
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, " UTC");
}

/**
 * Execute the nostr_fetch tool
 * Returns null if event is not found (expected condition)
 */
async function executeNostrFetch(input: NostrFetchInput): Promise<string | null> {
    const { eventId, format } = input;

    const ndk = getNDK();

    // Use the existing parseNostrEvent utility which handles all formats
    const event = await parseNostrEvent(eventId, ndk);

    if (!event) {
        // "Event not found" is an expected condition - return null to signal expected error
        return null;
    }

    // Return raw event JSON if requested
    if (format === "raw") {
        return JSON.stringify(event.rawEvent(), null, 2);
    }

    // Build display format
    const pubkeyService = getPubkeyService();
    const authorName = await pubkeyService.getName(event.pubkey);
    const timestamp = formatTimestamp(event.created_at || 0);

    // Format tags with bullet points
    const tagsSection =
        event.tags.length > 0
            ? `tags:\n${event.tags.map((tag) => `   * ${formatTag(tag)}`).join("\n")}`
            : "tags: (none)";

    const displayOutput = [
        `Event ID: ${event.id}`,
        `kind: ${event.kind}`,
        `author: @${authorName}`,
        `timestamp: ${timestamp}`,
        "",
        event.content,
        "",
        tagsSection,
    ].join("\n");

    return displayOutput;
}

/**
 * Create the nostr_fetch AI SDK tool
 */
export function createNostrFetchTool(_context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Fetches any nostr event by ID. Supports nevent, note, naddr, hex format, " +
            "with or without 'nostr:' prefix. Returns either raw JSON or a human-readable display format.",

        inputSchema: nostrFetchSchema,

        execute: async (input: NostrFetchInput) => {
            try {
                const result = await executeNostrFetch(input);

                // "Event not found" is an expected condition - return error-text
                if (result === null) {
                    return createExpectedError(`Event not found: ${input.eventId}`);
                }

                return result;
            } catch (error) {
                // Check if this is an expected "not found" error from a different code path
                if (isExpectedNotFoundError(error)) {
                    return createExpectedError(`Event not found: ${input.eventId}`);
                }

                logger.error("Failed to fetch nostr event", { eventId: input.eventId, error });
                throw new Error(
                    `Failed to fetch nostr event: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ eventId, format }: NostrFetchInput) => {
            return `Fetching nostr event ${eventId} (format: ${format || "display"})`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}
