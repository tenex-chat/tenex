import { ReportManager } from "@/services/ReportManager";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema, success, failure } from "../types";

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
  name: "report-write",
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

      // Publish status message with the Nostr reference to the article
      try {
        // Use shared AgentPublisher instance from context (guaranteed to be present)
        const conversation = context.conversationCoordinator.getConversation(context.conversationId);
        
        if (conversation?.history?.[0]) {
          const nostrReference = `nostr:${articleId}`;
          await context.agentPublisher.conversation(
            { type: "conversation", content: `📄 Writing report: ${nostrReference}` },
            {
              triggeringEvent: context.triggeringEvent,
              rootEvent: conversation.history[0],
              conversationId: context.conversationId,
            }
          );
        }
      } catch (statusError) {
        // Don't fail the tool if we can't publish the status
        console.warn("Failed to publish report_write status:", statusError);
      }

      return success({
        success: true,
        articleId: `nostr:${articleId}`,
        slug,
        message: `Report "${title}" published successfully`,
      });
    } catch (error) {
      logger.error("❌ Report write tool failed", {
        error: formatAnyError(error),
        slug,
        agent: context.agent.name,
        phase: context.phase,
      });

      return failure({
        kind: "execution" as const,
        tool: "report-write",
        message: formatAnyError(error),
      });
    }
  },
};