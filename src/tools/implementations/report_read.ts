import type { ToolExecutionContext } from "@/tools/types";
import { getLocalReportStore } from "@/services/reports";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const reportReadSchema = z.object({
    identifier: z
        .string()
        .describe("The slug of the report to read"),
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

    // If it looks like an naddr, we can't easily extract the slug without decoding
    // For now, we'll assume local storage uses slugs directly
    // naddr identifiers should still work via Nostr hydration
    if (slug.startsWith("naddr1")) {
        logger.warn("📖 naddr identifiers are not directly supported for local reads", {
            identifier,
            agent: context.agent.name,
        });
        return {
            success: false,
            message: `Please use the report slug instead of naddr identifier. naddr: ${identifier}`,
        };
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
