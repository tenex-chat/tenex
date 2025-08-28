import { ReportManager } from "@/services/ReportManager";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema, success, failure } from "../types";

const reportsListSchema = z.object({
  allAgents: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, get articles from all agents in the project. If false, only from current agent"),
});

interface ReportsListInput {
  allAgents?: boolean;
}

interface ReportSummary {
  id: string;
  slug: string;
  title?: string;
  summary?: string;
  author: string;
  publishedAt?: number;
  hashtags?: string[];
}

interface ReportsListOutput {
  success: boolean;
  reports: ReportSummary[];
  summary: {
    total: number;
    byAgent: Record<string, number>;
  };
  message?: string;
}

export const reportsListTool: Tool<ReportsListInput, ReportsListOutput> = {
  name: "reports_list",
  description: "List NDKArticle reports from agents in the project",

  promptFragment: `List reports (NDKArticles) from agents in the project.

Options:
- allAgents: false (default) - List only your reports
- allAgents: true - List reports from all agents in the project

The tool will return:
- A list of report summaries with IDs, titles, and metadata
- Articles are returned as bech32 encoded IDs (naddr1...)

Use this to discover available reports for reading or analysis.`,

  parameters: createZodSchema(reportsListSchema),

  execute: async (input, context) => {
    const { allAgents = false } = input.value;

    logger.info("📚 Listing reports", {
      allAgents,
      agent: context.agent.name,
      phase: context.phase,
    });

    try {
      const reportManager = new ReportManager();
      
      // Determine which agent pubkeys to use
      let agentPubkeys: string[] | undefined;
      
      if (!allAgents) {
        // Only current agent
        agentPubkeys = [context.agent.pubkey];
      } else {
        // Get all project agent pubkeys
        agentPubkeys = reportManager.getAllProjectAgentPubkeys();
      }

      // Fetch the reports
      const reports = await reportManager.listReports(agentPubkeys);
      
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

      return success({
        success: true,
        reports,
        summary: {
          total: reports.length,
          byAgent,
        },
        message: `Found ${reports.length} report${reports.length !== 1 ? 's' : ''}`,
      });
    } catch (error) {
      logger.error("❌ Reports list tool failed", {
        error: formatAnyError(error),
        allAgents,
        agent: context.agent.name,
        phase: context.phase,
      });

      return failure({
        kind: "execution" as const,
        tool: "reports_list",
        message: formatAnyError(error),
      });
    }
  },
};