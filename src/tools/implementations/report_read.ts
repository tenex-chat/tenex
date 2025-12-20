import type { ExecutionContext } from "@/agents/execution/types";
import { ReportService } from "@/services/reports";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const reportReadSchema = z.object({
    identifier: z
        .string()
        .describe("The slug (d-tag) or naddr1... identifier of the article to read"),
});

type ReportReadInput = z.infer<typeof reportReadSchema>;

interface ReportReadOutput {
    success: boolean;
    article?: {
        id: string;
        slug: string;
        title?: string;
        summary?: string;
        content?: string;
        author?: string;
        publishedAt?: number;
        hashtags?: string[];
        projectReference?: string;
    };
    humanReadable?: string;
    message?: string;
}

/**
 * Format article data for display
 */
function formatArticleContent(article: ReportReadOutput["article"]): string {
    if (!article) {
        return "No article data available";
    }

    const sections: string[] = [];

    // Title section
    if (article.title) {
        sections.push(`# ${article.title}`);
        sections.push(""); // Empty line for spacing
    }

    // Metadata section
    const metadata: string[] = [];

    if (article.slug) {
        metadata.push(`**Slug:** ${article.slug}`);
    }

    if (article.author) {
        metadata.push(`**Author:** ${article.author}`);
    }

    if (article.publishedAt) {
        const date = new Date(article.publishedAt * 1000);
        metadata.push(`**Published:** ${date.toLocaleString()}`);
    }

    if (article.hashtags && article.hashtags.length > 0) {
        metadata.push(`**Tags:** ${article.hashtags.map((tag) => `#${tag}`).join(", ")}`);
    }

    if (metadata.length > 0) {
        sections.push(metadata.join("\n"));
        sections.push(""); // Empty line for spacing
    }

    // Summary section
    if (article.summary) {
        sections.push("## Summary");
        sections.push(article.summary);
        sections.push(""); // Empty line for spacing
    }

    // Content section
    if (article.content) {
        sections.push("## Content");
        sections.push(article.content);
        sections.push(""); // Empty line for spacing
    }

    // Reference section
    if (article.projectReference) {
        sections.push("---");
        sections.push(`**Project Reference:** ${article.projectReference}`);
    }

    if (article.id) {
        if (!article.projectReference) {
            sections.push("---");
        }
        sections.push(`**Nostr ID:** ${article.id}`);
    }

    return sections.join("\n").trim();
}

/**
 * Core implementation of report reading functionality
 */
async function executeReportRead(
    input: ReportReadInput,
    context: ExecutionContext
): Promise<ReportReadOutput> {
    const { identifier } = input;

    logger.info("📖 Reading report", {
        identifier,
        agent: context.agent.name,
    });

    const reportService = new ReportService();

    // Remove nostr: prefix if present
    const cleanIdentifier = identifier.startsWith("nostr:") ? identifier.slice(6) : identifier;

    // Use agent pubkey for slug lookups
    const report = await reportService.readReport(cleanIdentifier, context.agent.pubkey);

    if (!report) {
        logger.info("📭 No report found", {
            identifier,
            agent: context.agent.name,
        });

        return {
            success: false,
            message: `No report found with identifier: ${identifier}`,
        };
    }

    // Check if the report is deleted
    if (report.isDeleted) {
        logger.info("🗑️ Report is deleted", {
            identifier,
            agent: context.agent.name,
        });

        return {
            success: false,
            message: `Report "${identifier}" has been deleted`,
        };
    }

    logger.info("✅ Report read successfully", {
        slug: report.slug,
        title: report.title,
        agent: context.agent.name,
    });

    const articleData = {
        id: report.id,
        slug: report.slug,
        title: report.title,
        summary: report.summary,
        content: report.content,
        author: report.author,
        publishedAt: report.publishedAt,
        hashtags: report.hashtags,
        projectReference: report.projectReference,
    };

    return {
        success: true,
        article: articleData,
        humanReadable: formatArticleContent(articleData),
    };
}

/**
 * Create an AI SDK tool for reading reports
 */
export function createReportReadTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description: "Read a report by slug or naddr identifier",

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
