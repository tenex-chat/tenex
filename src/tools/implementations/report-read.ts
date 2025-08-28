import { ReportManager } from "@/services/ReportManager";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema, success, failure } from "../types";

const reportReadSchema = z.object({
  identifier: z
    .string()
    .describe("The slug (d-tag) or naddr1... identifier of the article to read"),
});

interface ReportReadInput {
  identifier: string;
}

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
  message?: string;
}

export const reportReadTool: Tool<ReportReadInput, ReportReadOutput> = {
  name: "report_read",
  description: "Read an NDKArticle report by slug or naddr identifier",

  promptFragment: `Read a report (NDKArticle) by its slug or naddr identifier.

You can provide either:
- A slug (d-tag) - will search for articles with this d-tag from the current agent
- An naddr1... identifier - will fetch the specific article directly

The tool will return:
- The article content and metadata
- The author's npub
- Associated hashtags
- Project reference if tagged

Use this to retrieve and analyze previously written reports.`,

  parameters: createZodSchema(reportReadSchema),

  execute: async (input, context) => {
    const { identifier } = input.value;

    logger.info("📖 Reading report", {
      identifier,
      agent: context.agent.name,
      phase: context.phase,
    });

    try {
      const reportManager = new ReportManager();
      
      // Use agent pubkey for slug lookups
      const report = await reportManager.readReport(identifier, context.agent.pubkey);

      if (!report) {
        logger.info("📭 No report found", {
          identifier,
          agent: context.agent.name,
        });

        return success({
          success: false,
          message: `No report found with identifier: ${identifier}`,
        });
      }

      // Check if the report is deleted
      if (report.isDeleted) {
        logger.info("🗑️ Report is deleted", {
          identifier,
          agent: context.agent.name,
        });

        return success({
          success: false,
          message: `Report "${identifier}" has been deleted`,
        });
      }

      logger.info("✅ Report read successfully", {
        slug: report.slug,
        title: report.title,
        agent: context.agent.name,
      });

      return success({
        success: true,
        article: {
          id: report.id,
          slug: report.slug,
          title: report.title,
          summary: report.summary,
          content: report.content,
          author: report.author,
          publishedAt: report.publishedAt,
          hashtags: report.hashtags,
          projectReference: report.projectReference,
        },
      });
    } catch (error) {
      logger.error("❌ Report read tool failed", {
        error: formatAnyError(error),
        identifier,
        agent: context.agent.name,
        phase: context.phase,
      });

      return failure({
        kind: "execution" as const,
        tool: "report_read",
        message: formatAnyError(error),
      });
    }
  },
};