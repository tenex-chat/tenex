import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { ReportService } from "@/services/reports";
import { getProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";
import { nip19 } from "nostr-tools";

const reportsListSchema = z.object({});

type ReportsListInput = z.infer<typeof reportsListSchema>;

type ReportSummary = {
    slug: string;
    title?: string;
    summary?: string;
    author: string;
    publishedAt?: number;
    hashtags?: string[];
};

type ReportsListOutput = {
    success: boolean;
    reports: ReportSummary[];
};

/**
 * Extract hex pubkey from author string (handles npub and hex formats)
 */
function extractPubkeyFromAuthor(author: string): string | undefined {
    if (!author) return undefined;

    // If it's an npub, decode it
    if (author.startsWith("npub1")) {
        try {
            const decoded = nip19.decode(author);
            if (decoded.type === "npub") {
                return decoded.data as string;
            }
        } catch {
            return undefined;
        }
    }

    // Assume it's already a hex pubkey
    return author;
}

// Core implementation - extracted from existing execute function
async function executeReportsList(
    _input: ReportsListInput,
    context: ToolExecutionContext
): Promise<ReportsListOutput> {
    logger.info("📚 Listing reports", {
        agent: context.agent.name,
    });

    const reportService = new ReportService();
    const projectCtx = getProjectContext();

    // Fetch all reports in the project
    const rawReports = await reportService.listReports();

    // Transform reports: remove id, convert author npub to slug
    const reports: ReportSummary[] = rawReports.map((report) => {
        // Try to resolve author npub to agent slug
        const authorPubkey = extractPubkeyFromAuthor(report.author);
        let authorSlug = report.author; // fallback to original author

        if (authorPubkey) {
            const agent = projectCtx.getAgentByPubkey(authorPubkey);
            if (agent) {
                authorSlug = agent.slug;
            }
        }

        return {
            slug: report.slug,
            title: report.title,
            summary: report.summary,
            author: authorSlug,
            publishedAt: report.publishedAt,
            hashtags: report.hashtags,
        };
    });

    logger.info("✅ Reports listed successfully", {
        total: reports.length,
        agent: context.agent.name,
    });

    return {
        success: true,
        reports,
    };
}

// AI SDK tool factory
export function createReportsListTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description: "List NDKArticle reports from agents in the project",
        inputSchema: reportsListSchema,
        execute: async (input: ReportsListInput) => {
            return await executeReportsList(input, context);
        },
    }) as AISdkTool;
} 
