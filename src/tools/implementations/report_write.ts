import type { ToolExecutionContext } from "@/tools/types";
import { PendingDelegationsRegistry } from "@/services/ral";
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
    memorize_team: z
        .boolean()
        .default(false)
        .describe(
            "⚠️ HIGH CONTEXT COST - When true, the report content will be injected into the system prompt of ALL agents in the project, not just the authoring agent. Use ONLY for SHORT documents that are critical for EVERY agent to know. Examples: critical project-wide conventions, emergency procedures, or announcements that affect all agents. NEVER use for long documents or agent-specific information."
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
    const { slug, title, summary, content, hashtags, memorize, memorize_team } = input;

    logger.info("📝 Writing report", {
        slug,
        title,
        memorize,
        memorize_team,
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
            memorizeTeam: memorize_team,
        },
        context.agent
    );

    let memorizeMessage = "";
    if (memorize_team) {
        memorizeMessage = " ⚠️ This report has been team-memorized and will be included in the system prompt of ALL agents in the project.";
    } else if (memorize) {
        memorizeMessage = " This report has been memorized and will be included in your system prompt.";
    }

    logger.info("✅ Report written successfully", {
        slug,
        articleId: result.encodedId,
        addressableRef: result.addressableRef,
        memorize,
        memorize_team,
        agent: context.agent.name,
    });

    // Register with PendingDelegationsRegistry for a-tag correlation
    PendingDelegationsRegistry.registerAddressable(
        context.agent.pubkey,
        context.conversationId,
        result.addressableRef
    );

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
        description: `Write reports and documentation as NDKArticle events. Use for creating persistent documentation ABOUT THE PROJECT, such as:
- Architecture documentation
- Implementation plans
- Project summaries
- Design decisions
- Technical specifications
- API documentation
- Team guidelines and conventions

Reports are stored on Nostr network and accessible via slug. Updates existing reports with same slug. Supports markdown format and hashtags for categorization. Reports can be read back with report_read or listed with reports_list.

**CRITICAL:** Only use this for content ABOUT THE PROJECT. For content about your behavior or patterns in how you work, use lesson_learn instead.

**NEVER use for:**
- Behavioral patterns or workflows
- User preferences or communication styles
- Debugging approaches or work patterns
- "I've learned to..." statements about your approach

**Memorize Parameter**: Set memorize=true when the report contains information that is fundamental to your role and should always be available in your system prompt. Use this for:
- Core architectural decisions you need to reference frequently
- Domain knowledge essential to your function
- Project conventions or patterns you must follow consistently
- Any content you want persisted across all future conversations

When memorize=true, a "memorize" tag is added to the article and the content will be automatically injected into your system prompt.

**Memorize Team Parameter** (⚠️ USE WITH EXTREME CAUTION):
Set memorize_team=true ONLY when the report MUST be visible to EVERY agent in the project.

⚠️ **HIGH CONTEXT WINDOW COST** - This injects content into ALL agents' system prompts!

**ONLY use memorize_team for:**
- Critical project-wide conventions that ALL agents must follow
- Emergency procedures or time-sensitive announcements
- Extremely short (<500 chars) shared context that every agent needs

**NEVER use memorize_team for:**
- Long documents (architecture docs, specs, etc.)
- Agent-specific information
- Content that only some agents need
- General documentation (use regular reports instead)

When memorize_team=true, a "memorize_team" tag is added and the content will be injected into the system prompt of ALL agents.

See also: lesson_learn (for behavioral insights)`,
        inputSchema: reportWriteSchema,
        execute: async (input: ReportWriteInput) => {
            return await executeReportWrite(input, context);
        },
    }) as AISdkTool;
}
