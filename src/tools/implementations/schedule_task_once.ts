import { resolveRecipientToPubkey } from "@/services/agents";
import { SchedulerService } from "@/services/scheduling";
import { formatDelay, formatExecuteAt, parseRelativeDelay } from "@/services/scheduling/utils";
import type { ToolExecutionContext } from "@/tools/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

/**
 * Creates a tool for scheduling one-off tasks with relative delays
 */
export function createScheduleTaskOnceTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Schedule a one-off task to execute after a relative delay (e.g., '5m' for 5 minutes, '2h' for 2 hours, '3d' for 3 days). The task runs once and is automatically deleted after execution.",
        inputSchema: z.object({
            title: z
                .string()
                .optional()
                .describe("A human-readable title for the task (e.g., 'Follow up on PR review')"),
            prompt: z.string().describe("The prompt/message to send when the task executes"),
            delay: z
                .string()
                .describe(
                    "Relative delay before execution. Format: Xm (minutes), Xh (hours), or Xd (days). Examples: '30m', '2h', '1d'"
                ),
            targetAgent: z
                .string()
                .nullable()
                .optional()
                .describe(
                    "Target agent slug (e.g., 'architect'), name, npub, or hex pubkey. Defaults to self."
                ),
        }),
        execute: async ({ title, prompt, delay, targetAgent }) => {
            try {
                // Parse the relative delay
                const delayMs = parseRelativeDelay(delay);
                if (delayMs === null) {
                    return {
                        success: false,
                        error: `Invalid delay format: '${delay}'. Use format like '5m' (minutes), '2h' (hours), or '3d' (days).`,
                    };
                }

                // Calculate the absolute execution time
                const now = new Date();
                const executeAt = new Date(now.getTime() + delayMs);

                const schedulerService = SchedulerService.getInstance();

                // Resolve target agent to pubkey if specified
                let toPubkey: string;
                if (targetAgent) {
                    const resolved = resolveRecipientToPubkey(targetAgent);
                    if (!resolved) {
                        return {
                            success: false,
                            error: `Could not resolve target agent: ${targetAgent}. Use agent slug (e.g., 'architect'), name, npub, or hex pubkey.`,
                        };
                    }
                    toPubkey = resolved;
                } else {
                    // Default to self if no target specified
                    toPubkey = context.agent.pubkey;
                }

                // The agent scheduling the task is always the current agent
                const fromPubkey = context.agent.pubkey;

                // Add one-off task to scheduler
                const taskId = await schedulerService.addOneoffTask(
                    executeAt,
                    prompt,
                    fromPubkey,
                    toPubkey,
                    undefined, // projectId - let it be resolved from context
                    title
                );

                logger.info(
                    `Successfully created one-off task ${taskId} to execute at: ${executeAt.toISOString()}`
                );

                return {
                    success: true,
                    taskId,
                    message: "One-off task scheduled successfully",
                    title,
                    delay,
                    delayHuman: formatDelay(delay),
                    executeAt: executeAt.toISOString(),
                    executeAtFormatted: formatExecuteAt(executeAt.toISOString()),
                    prompt,
                    targetAgent: targetAgent || "self",
                };
            } catch (error: unknown) {
                logger.error("Failed to schedule one-off task:", error);

                return {
                    success: false,
                    error:
                        error instanceof Error ? error.message : "Failed to schedule one-off task",
                };
            }
        },
    });

    // Attach getHumanReadableContent as non-enumerable property
    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: (args: {
            title?: string;
            prompt: string;
            delay: string;
            targetAgent?: string | null;
        }) => {
            // Handle both undefined and null for targetAgent
            const target = args.targetAgent ? ` for ${args.targetAgent}` : "";
            const titlePart = args.title ? `'${args.title}' ` : "";
            return `Scheduling one-off task ${titlePart}in ${formatDelay(args.delay)}${target}: ${args.prompt}`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
