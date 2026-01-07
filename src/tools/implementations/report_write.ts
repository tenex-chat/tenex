import type { ToolExecutionContext } from "@/tools/types";
import { ReportService } from "@/services/reports";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const reportWriteSchema = z.object({
    slug: z.string().describe("The slug identifier for the article, used as the d-tag"),
    title: z.string().describe("The title of the report"),
    summary: z.string().describe("A one-line summary of the report"),
    content: z.string().describe("The full content of the report in markdown format"),
    hashtags: z
        .array(z.string())
        .default([])
        .describe("Array of hashtags to add to the article (without the # prefix)"),
    memorize: z
        .boolean()
        .default(false)
        .describe(
            "When true, the report content will be automatically added to this agent's system prompt as persistent context. Use this for reports that are fundamental to your role (e.g., architecture decisions, domain knowledge, project conventions) that you want to always have available."
        ),
});

type ReportWriteInput = z.infer<typeof reportWriteSchema>;
type ReportWriteOutput = {
    success: boolean;
    articleId: string;
    slug: string;
    message: string;
    /** Addressable event references for a-tagging on the tool use event */
    referencedAddressableEvents: string[];
};

// Core implementation - extracted from existing execute function
async function executeReportWrite(
    input: ReportWriteInput,
    context: ToolExecutionContext
): Promise<ReportWriteOutput> {
    const { slug, title, summary, content, hashtags, memorize } = input;

    logger.info("📝 Writing report", {
        slug,
        title,
        memorize,
        agent: context.agent.name,
    });

    const reportService = new ReportService();

    const result = await reportService.writeReport(
        {
            slug,
            title,
            summary,
            content,
            hashtags,
            memorize,
        },
        context.agent
    );

    const memorizeMessage = memorize
        ? " This report has been memorized and will be included in your system prompt."
        : "";

    logger.info("✅ Report written successfully", {
        slug,
        articleId: result.encodedId,
        addressableRef: result.addressableRef,
        memorize,
        agent: context.agent.name,
    });

    return {
        success: true,
        articleId: `nostr:${result.encodedId}`,
        slug,
        message: `Report "${title}" published successfully.${memorizeMessage}`,
        // Include addressable reference for ToolExecutionTracker to add as a-tag
        referencedAddressableEvents: [result.addressableRef],
    };
}

// AI SDK tool factory
export function createReportWriteTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description: `Write reports and documentation as NDKArticle events. Use for creating persistent documentation like architecture docs, implementation plans, or project summaries. Reports are stored on Nostr network and accessible via slug. Updates existing reports with same slug. Supports markdown format and hashtags for categorization. Reports can be read back with report_read or listed with reports_list.

**Memorize Parameter**: Set memorize=true when the report contains information that is fundamental to your role and should always be available in your system prompt. Use this for:
- Core architectural decisions you need to reference frequently
- Domain knowledge essential to your function
- Project conventions or patterns you must follow consistently
- Any content you want persisted across all future conversations

When memorize=true, a "memorize" tag is added to the article and the content will be automatically injected into your system prompt.`,
        inputSchema: reportWriteSchema,
        execute: async (input: ReportWriteInput) => {
            return await executeReportWrite(input, context);
        },
    }) as AISdkTool;
}
