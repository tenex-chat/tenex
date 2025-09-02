import { tool } from 'ai';
import { ReportManager } from "@/services/ReportManager";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";

const reportReadSchema = z.object({
  identifier: z
    .string()
    .describe("The slug (d-tag) or naddr1... identifier of the article to read"),
});

type ReportReadInput = z.infer<typeof reportReadSchema>;

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

/**
 * Core implementation of report reading functionality
 */
async function executeReportRead(
  input: ReportReadInput,
  context: ExecutionContext
): Promise<ReportReadOutput> {
  const { identifier } = input;

  logger.info("📖 Reading report", {
    identifier,
    agent: context.agent.name,
    phase: context.phase,
  });

  const reportManager = new ReportManager();
  
  // Use agent pubkey for slug lookups
  const report = await reportManager.readReport(identifier, context.agent.pubkey);

  if (!report) {
    logger.info("📭 No report found", {
      identifier,
      agent: context.agent.name,
    });

    return {
      success: false,
      message: `No report found with identifier: ${identifier}`,
    };
  }

  // Check if the report is deleted
  if (report.isDeleted) {
    logger.info("🗑️ Report is deleted", {
      identifier,
      agent: context.agent.name,
    });

    return {
      success: false,
      message: `Report "${identifier}" has been deleted`,
    };
  }

  logger.info("✅ Report read successfully", {
    slug: report.slug,
    title: report.title,
    agent: context.agent.name,
  });

  return {
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
  };
}

/**
 * Create an AI SDK tool for reading reports
 */
export function createReportReadTool(context: ExecutionContext) {
  return tool({
    description: "Read an NDKArticle report by slug or naddr identifier",
    
    inputSchema: reportReadSchema,
    
    execute: async (input: ReportReadInput) => {
      return await executeReportRead(input, context);
    },
  });
}
