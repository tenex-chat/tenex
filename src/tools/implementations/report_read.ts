import type { ToolExecutionContext } from "@/tools/types";
import { getLocalReportStore, InvalidSlugError } from "@/services/reports";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";
import { nip19 } from "nostr-tools";

const reportReadSchema = z.object({
    identifier: z
        .string()
        .describe("The report identifier - can be a slug (e.g., 'my-report'), an naddr (e.g., 'naddr1...'), or a nostr: URI (e.g., 'nostr:naddr1...')"),
});

type ReportReadInput = z.infer<typeof reportReadSchema>;

interface ReportReadOutput {
    success: boolean;
    slug?: string;
    content?: string;
    message?: string;
}

/**
 * Core implementation of report reading functionality
 * Reads exclusively from local file storage
 */
async function executeReportRead(
    input: ReportReadInput,
    context: ToolExecutionContext
): Promise<ReportReadOutput> {
    const { identifier } = input;

    logger.info("📖 Reading report from local storage", {
        identifier,
        agent: context.agent.name,
    });

    const localStore = getLocalReportStore();

    // Clean the identifier - extract slug if it's an naddr or has nostr: prefix
    let slug = identifier;

    // Remove nostr: prefix if present
    if (slug.startsWith("nostr:")) {
        slug = slug.slice(6);
    }

    // If it looks like an naddr, decode it to extract the slug (d-tag)
    // Reports are NDKArticle events (kind 30023)
    if (slug.startsWith("naddr1")) {
        try {
            const decoded = nip19.decode(slug);
            if (decoded.type === "naddr") {
                // Verify this is a report (kind 30023) - NDKArticle
                if (decoded.data.kind !== 30023) {
                    return {
                        success: false,
                        message: `Invalid naddr kind ${decoded.data.kind} - report_read only accepts kind 30023 (NDKArticle) naddrs. Got: ${identifier}`,
                    };
                }
                if (decoded.data.identifier) {
                    slug = decoded.data.identifier;
                    logger.debug("📖 Decoded naddr to slug", {
                        originalIdentifier: identifier,
                        extractedSlug: slug,
                        kind: decoded.data.kind,
                        agent: context.agent.name,
                    });
                } else {
                    return {
                        success: false,
                        message: `Invalid naddr format - missing identifier (d-tag) in: ${identifier}`,
                    };
                }
            } else {
                return {
                    success: false,
                    message: `Invalid naddr format - could not extract report slug from: ${identifier}`,
                };
            }
        } catch (decodeError) {
            logger.warn("📖 Failed to decode naddr identifier", {
                identifier,
                error: decodeError instanceof Error ? decodeError.message : String(decodeError),
                agent: context.agent.name,
            });
            return {
                success: false,
                message: `Failed to decode naddr identifier: ${identifier}. Please provide a valid slug or naddr.`,
            };
        }
    }

    // Validate the slug for path safety
    try {
        localStore.validateSlug(slug);
    } catch (error) {
        if (error instanceof InvalidSlugError) {
            return {
                success: false,
                message: error.message,
            };
        }
        throw error;
    }

    // Read from local storage
    const content = await localStore.readReport(slug);

    if (!content) {
        logger.info("📭 No local report found", {
            slug,
            path: localStore.getReportPath(slug),
            agent: context.agent.name,
        });

        return {
            success: false,
            message: `No report found with slug: ${slug}. The report may not have been written yet or synced from Nostr.`,
        };
    }

    logger.info("✅ Report read successfully from local storage", {
        slug,
        contentLength: content.length,
        agent: context.agent.name,
    });

    return {
        success: true,
        slug,
        content,
    };
}

/**
 * Create an AI SDK tool for reading reports
 */
export function createReportReadTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description: "Read a report by slug identifier",

        inputSchema: reportReadSchema,

        execute: async (input: ReportReadInput) => {
            return await executeReportRead(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ identifier }: ReportReadInput) => {
            return `Reading report: ${identifier}`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
