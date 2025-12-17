import type { ExecutionContext } from "@/agents/execution/types";
import { ALPHA_BUG_HASHTAG, TENEX_BACKEND_PROJECT_ATAG } from "@/constants";
import { getNDK } from "@/nostr";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { tool } from "ai";
import { z } from "zod";

const bugReportCreateSchema = z.object({
    title: z.string().describe("Brief, descriptive title for the bug (e.g., 'Tool X fails with error Y')"),
    description: z
        .string()
        .describe(
            "Detailed bug description including: what happened, what was expected, steps to reproduce if known, any error messages"
        ),
});

type BugReportCreateInput = z.infer<typeof bugReportCreateSchema>;

interface BugReportCreateOutput {
    success: boolean;
    bugId: string;
    message: string;
}

async function executeBugReportCreate(
    input: BugReportCreateInput,
    context: ExecutionContext
): Promise<BugReportCreateOutput> {
    const ndk = getNDK();
    if (!ndk) {
        throw new Error("NDK instance not available");
    }

    logger.info("Creating alpha bug report", {
        title: input.title,
        agent: context.agent.name,
    });

    // Create kind:11 event (conversation root)
    const event = new NDKEvent(ndk);
    event.kind = 11;
    event.content = `# ${input.title}\n\n${input.description}`;

    // Add required tags
    event.tags = [
        ["title", input.title],
        ["t", ALPHA_BUG_HASHTAG],
        ["a", TENEX_BACKEND_PROJECT_ATAG],
        // No p-tags - don't route to anyone
    ];

    // Sign with the agent's signer
    if (!context.agent.signer) {
        throw new Error("No signer available for agent");
    }

    await event.sign(context.agent.signer);
    await event.publish();

    logger.info("Alpha bug report created", {
        bugId: event.id,
        title: input.title,
        agent: context.agent.name,
    });

    return {
        success: true,
        bugId: event.id,
        message: `Bug report created: "${input.title}" (ID: ${event.id})`,
    };
}

export function createBugReportCreateTool(context: ExecutionContext): AISdkTool {
    const coreTool = tool({
        description:
            "Create a new bug report for TENEX alpha issues. Use this when you encounter bugs, errors, or unexpected behavior that hasn't been reported yet. Always check bug_list first to avoid duplicates.",
        inputSchema: bugReportCreateSchema,
        execute: async (input: BugReportCreateInput) => {
            return await executeBugReportCreate(input, context);
        },
    }) as AISdkTool;

    coreTool.getHumanReadableContent = (input: unknown) => {
        const typedInput = input as BugReportCreateInput;
        return `Creating bug report: ${typedInput.title}`;
    };

    return coreTool;
}
