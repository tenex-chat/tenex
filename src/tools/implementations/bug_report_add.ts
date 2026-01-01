import type { ExecutionContext } from "@/agents/execution/types";
import { ALPHA_BUG_HASHTAG, TENEX_BACKEND_PROJECT_ATAG } from "@/constants";
import { getNDK } from "@/nostr";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { tool } from "ai";
import { z } from "zod";

const bugReportAddSchema = z.object({
    bugId: z.string().describe("The event ID of the bug report to add to (from bug_list)"),
    content: z
        .string()
        .describe(
            "Additional information to add: reproduction steps, observations, potential fixes, workarounds, or status updates"
        ),
});

type BugReportAddInput = z.infer<typeof bugReportAddSchema>;

interface BugReportAddOutput {
    success: boolean;
    replyId: string;
    message: string;
}

async function executeBugReportAdd(
    input: BugReportAddInput,
    context: ExecutionContext
): Promise<BugReportAddOutput> {
    const ndk = getNDK();
    if (!ndk) {
        throw new Error("NDK instance not available");
    }

    // Verify the bug report exists
    const bugEvent = await ndk.fetchEvent(input.bugId);
    if (!bugEvent) {
        throw new Error(`Bug report not found: ${input.bugId}`);
    }

    // Verify it's actually a bug report (kind:1 with alpha-bug tag)
    if (bugEvent.kind !== 1) {
        throw new Error(`Event ${input.bugId} is not a bug report (kind ${bugEvent.kind}, expected 1)`);
    }

    const hasBugTag = bugEvent.tags.some((t) => t[0] === "t" && t[1] === ALPHA_BUG_HASHTAG);
    if (!hasBugTag) {
        throw new Error(`Event ${input.bugId} is not an alpha bug report (missing #${ALPHA_BUG_HASHTAG} tag)`);
    }

    logger.info("Adding to alpha bug report", {
        bugId: input.bugId,
        agent: context.agent.name,
    });

    // Create reply
    const reply = new NDKEvent(ndk);
    reply.kind = 1;
    reply.content = input.content;

    // Add threading tags per NIP-22
    reply.tags = [
        ["E", input.bugId, "", "root"], // Root reference (the bug report)
        ["e", input.bugId, "", "reply"], // Direct reply to
        ["a", TENEX_BACKEND_PROJECT_ATAG],
        ["t", ALPHA_BUG_HASHTAG],
        // No p-tags - don't route to anyone
    ];

    // Sign with the agent's signer
    if (!context.agent.signer) {
        throw new Error("No signer available for agent");
    }

    await reply.sign(context.agent.signer);
    await reply.publish();

    const bugTitle = bugEvent.tagValue("title") || bugEvent.content.substring(0, 30);
    logger.info("Added to alpha bug report", {
        replyId: reply.id,
        bugId: input.bugId,
        bugTitle,
        agent: context.agent.name,
    });

    return {
        success: true,
        replyId: reply.id,
        message: `Added to bug report "${bugTitle}" (Reply ID: ${reply.id})`,
    };
}

export function createBugReportAddTool(context: ExecutionContext): AISdkTool {
    const coreTool = tool({
        description:
            "Add additional information to an existing bug report. Use this to provide reproduction steps, observations, potential fixes, workarounds, or status updates to a bug that has already been reported.",
        inputSchema: bugReportAddSchema,
        execute: async (input: BugReportAddInput) => {
            return await executeBugReportAdd(input, context);
        },
    }) as AISdkTool;

    coreTool.getHumanReadableContent = (input: unknown) => {
        const typedInput = input as BugReportAddInput;
        return `Adding to bug report ${typedInput.bugId.substring(0, 8)}...`;
    };

    return coreTool;
}
