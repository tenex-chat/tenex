import { ReportManager } from "@/services/ReportManager";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema } from "../types";

const reportWriteSchema = z.object({
  slug: z.string().describe("The slug identifier for the article, used as the d-tag"),
  title: z.string().describe("The title of the report"),
  summary: z.string().describe("A one-line summary of the report"),
  content: z.string().describe("The full content of the report in markdown format"),
  hashtags: z
    .array(z.string())
    .optional()
    .describe("Array of hashtags to add to the article (without the # prefix)"),
});

interface ReportWriteInput {
  slug: string;
  title: string;
  summary: string;
  content: string;
  hashtags?: string[];
}

interface ReportWriteOutput {
  success: boolean;
  articleId: string;
  slug: string;
  message: string;
}

export const reportWriteTool: Tool<ReportWriteInput, ReportWriteOutput> = {
  name: "report_write",
  description: "Generate or update an NDKArticle report for the current project",

  promptFragment: `Generate or update a report as an NDKArticle.

WARNING: This will completely overwrite any existing report with the same slug. The entire content will be replaced with what you provide.

The report will be:
- Tagged to the current project automatically
- Published with the provided slug as the d-tag (for easy updates)
- Encoded and returned as a bech32 naddr string

Use this to create structured reports that can be:
- Updated later using the same slug
- Discovered by other agents via reports_list
- Read by anyone using the article ID

The slug should be descriptive and consistent (e.g., "security-audit-2024", "performance-analysis", "architecture-review")`,

  parameters: createZodSchema(reportWriteSchema),

  execute: async (input, context) => {
    const { slug, title, summary, content, hashtags } = input.value;

    logger.info("📝 Writing report", {
      slug,
      title,
      agent: context.agent.name,
      phase: context.phase,
    });

    try {
      const reportManager = new ReportManager();
      
      const articleId = await reportManager.writeReport(
        {
          slug,
          title,
          summary,
          content,
          hashtags,
        },
        context.agent
      );
      
      logger.info("✅ Report written successfully", {
        slug,
        articleId,
        agent: context.agent.name,
      });

      return {
        ok: true,
        value: {
          success: true,
          articleId,
          slug,
          message: `Report "${title}" published successfully`,
        },
      };
    } catch (error) {
      logger.error("❌ Report write tool failed", {
        error: formatAnyError(error),
        slug,
        agent: context.agent.name,
        phase: context.phase,
      });

      return {
        ok: false,
        error: {
          kind: "execution" as const,
          tool: "report_write",
          message: formatAnyError(error),
        },
      };
    }
  },
};