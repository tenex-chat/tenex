import type { AISdkTool, ToolContext } from "@/tools/types";
import { ReportService } from "@/services/reports";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const reportsListSchema = z.object({
    allAgents: z
        .boolean()
        .nullable()
        .default(false)
        .describe(
            "If true, get articles from all agents in the project. If false, only from current agent"
        ),
});

type ReportsListInput = z.infer<typeof reportsListSchema>;

type ReportSummary = {
    id: string;
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
    summary: {
        total: number;
        byAgent: Record<string, number>;
    };
    message?: string;
};

// Core implementation - extracted from existing execute function
async function executeReportsList(
    input: ReportsListInput,
    context: ToolContext
): Promise<ReportsListOutput> {
    const { allAgents = false } = input;

    logger.info("📚 Listing reports", {
        allAgents,
        agent: context.agent.name,
    });

    const reportService = new ReportService();

    // Determine which agent pubkeys to use
    let agentPubkeys: string[] | undefined;

    if (!allAgents) {
        // Only current agent
        agentPubkeys = [context.agent.pubkey];
    } else {
        // Get all project agent pubkeys
        agentPubkeys = reportService.getAllProjectAgentPubkeys();
    }

    // Fetch the reports
    const reports = await reportService.listReports(agentPubkeys);

    // Calculate summary statistics
    const byAgent: Record<string, number> = {};
    for (const report of reports) {
        byAgent[report.author] = (byAgent[report.author] || 0) + 1;
    }

    logger.info("✅ Reports listed successfully", {
        total: reports.length,
        allAgents,
        agent: context.agent.name,
    });

    return {
        success: true,
        reports,
        summary: {
            total: reports.length,
            byAgent,
        },
        message: `Found ${reports.length} report${reports.length !== 1 ? "s" : ""}`,
    };
}

// AI SDK tool factory
export function createReportsListTool(context: ToolContext): AISdkTool {
    return tool({
        description: "List NDKArticle reports from agents in the project",
        inputSchema: reportsListSchema,
        execute: async (input: ReportsListInput) => {
            return await executeReportsList(input, context);
        },
    }) as AISdkTool;
} 
