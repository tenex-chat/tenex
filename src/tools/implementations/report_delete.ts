import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { ReportService } from "@/services/reports";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const reportDeleteSchema = z.object({
    slug: z.string().describe("The slug identifier (d-tag) of the report to delete"),
});

type ReportDeleteInput = z.infer<typeof reportDeleteSchema>;

interface ReportDeleteOutput {
    success: boolean;
    articleId: string;
    slug: string;
    message: string;
}

/**
 * Core implementation of report deletion functionality
 */
async function executeReportDelete(
    input: ReportDeleteInput,
    context: ExecutionContext
): Promise<ReportDeleteOutput> {
    const { slug } = input;

    logger.info("🗑️ Deleting report", {
        slug,
        agent: context.agent.name,
    });

    const reportService = new ReportService();

    const articleId = await reportService.deleteReport(slug, context.agent);

    logger.info("✅ Report deleted successfully", {
        slug,
        articleId,
        agent: context.agent.name,
    });

    return {
        success: true,
        articleId: `nostr:${articleId}`,
        slug,
        message: `Report "${slug}" marked as deleted`,
    };
}

/**
 * Create an AI SDK tool for deleting reports
 */
export function createReportDeleteTool(context: ExecutionContext): AISdkTool {
    return tool({
        description: "Mark an NDKArticle report as deleted",

        inputSchema: reportDeleteSchema,

        execute: async (input: ReportDeleteInput) => {
            return await executeReportDelete(input, context);
        },
    }) as AISdkTool;
} 
