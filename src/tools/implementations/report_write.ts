import { tool } from 'ai';
import { ReportManager } from "@/services/ReportManager";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";

const reportWriteSchema = z.object({
  slug: z.string().describe("The slug identifier for the article, used as the d-tag"),
  title: z.string().describe("The title of the report"),
  summary: z.string().describe("A one-line summary of the report"),
  content: z.string().describe("The full content of the report in markdown format"),
  hashtags: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Array of hashtags to add to the article (without the # prefix)"),
});

type ReportWriteInput = z.infer<typeof reportWriteSchema>;
type ReportWriteOutput = {
  success: boolean;
  articleId: string;
  slug: string;
  message: string;
};

// Core implementation - extracted from existing execute function
async function executeReportWrite(input: ReportWriteInput, context: ExecutionContext): Promise<ReportWriteOutput> {
  const { slug, title, summary, content, hashtags } = input;

  logger.info("📝 Writing report", {
    slug,
    title,
    agent: context.agent.name,
    phase: context.phase,
  });

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
        { content: `📄 Writing report: ${nostrReference}` },
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

  return {
    success: true,
    articleId: `nostr:${articleId}`,
    slug,
    message: `Report "${title}" published successfully`,
  };
}

// AI SDK tool factory
export function createReportWriteTool(context: ExecutionContext): ReturnType<typeof tool> {
  return tool({
    description: "Write reports and documentation as NDKArticle events. Use for creating persistent documentation like architecture docs, implementation plans, or project summaries. Reports are stored on Nostr network and accessible via slug. Updates existing reports with same slug. Supports markdown format and hashtags for categorization. Reports can be read back with report_read or listed with reports_list.",
    inputSchema: reportWriteSchema,
    execute: async (input: ReportWriteInput) => {
      return await executeReportWrite(input, context);
    },
  });
}

