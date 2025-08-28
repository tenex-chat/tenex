import { ReportManager } from "@/services/ReportManager";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema, success, failure } from "../types";

const reportDeleteSchema = z.object({
  slug: z.string().describe("The slug identifier (d-tag) of the report to delete"),
});

interface ReportDeleteInput {
  slug: string;
}

interface ReportDeleteOutput {
  success: boolean;
  articleId: string;
  slug: string;
  message: string;
}

export const reportDeleteTool: Tool<ReportDeleteInput, ReportDeleteOutput> = {
  name: "report_delete",
  description: "Mark an NDKArticle report as deleted",

  promptFragment: `Mark a report as deleted by clearing its content and adding a deleted tag.

This will:
- Empty the content of the article
- Add a "deleted" tag to mark it as deleted
- The report will be filtered out from reports_list results
- The slug remains reserved and can be reused later

Note: This is a soft delete - the article still exists but is marked as deleted.`,

  parameters: createZodSchema(reportDeleteSchema),

  execute: async (input, context) => {
    const { slug } = input.value;

    logger.info("🗑️ Deleting report", {
      slug,
      agent: context.agent.name,
      phase: context.phase,
    });

    try {
      const reportManager = new ReportManager();
      
      const articleId = await reportManager.deleteReport(slug, context.agent);
      
      logger.info("✅ Report deleted successfully", {
        slug,
        articleId,
        agent: context.agent.name,
      });

      return success({
        success: true,
        articleId: `nostr:${articleId}`,
        slug,
        message: `Report "${slug}" marked as deleted`,
      });
    } catch (error) {
      logger.error("❌ Report delete tool failed", {
        error: formatAnyError(error),
        slug,
        agent: context.agent.name,
        phase: context.phase,
      });

      return failure({
        kind: "execution" as const,
        tool: "report_delete",
        message: formatAnyError(error),
      });
    }
  },
};