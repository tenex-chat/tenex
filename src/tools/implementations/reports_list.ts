import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { ReportService } from "@/services/reports";
import { getProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

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

    // Transform reports: remove id, convert author hex pubkey to slug
    const reports: ReportSummary[] = rawReports.map((report) => {
        // Try to resolve author pubkey to agent slug
        const agent = projectCtx.getAgentByPubkey(report.author);
        const authorSlug = agent?.slug ?? report.author;

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
