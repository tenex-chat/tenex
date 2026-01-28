import type { ToolExecutionContext } from "@/tools/types";
import { SchedulerService } from "@/services/scheduling";
import type { AISdkTool } from "@/tools/types";
import { resolveAgentSlug } from "@/services/agents";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import * as cron from "node-cron";
import { z } from "zod";

/**
 * Creates a tool for scheduling tasks using cron notation
 */
export function createScheduleTaskTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Schedule a task using cron notation (e.g., '0 9 * * *' for daily at 9am, '*/5 * * * *' for every 5 minutes)",
        inputSchema: z.object({
            title: z
                .string()
                .optional()
                .describe("A human-readable title for the scheduled task (e.g., 'Daily standup reminder')"),
            prompt: z.string().describe("The prompt to execute when the task runs"),
            schedule: z
                .string()
                .describe(
                    "Cron expression for scheduling (e.g., '0 9 * * *' for daily at 9am, '0 * * * *' for hourly)"
                ),
            targetAgent: z
                .string()
                .nullable()
                .describe(
                    "Target agent slug (e.g., 'architect', 'claude-code'). Only agent slugs are accepted."
                ),
        }),
        execute: async ({ title, prompt, schedule, targetAgent }) => {
            // Validate cron expression - throw for invalid input (consistent with delegate tool)
            if (!cron.validate(schedule)) {
                throw new Error(
                    `Invalid cron expression: ${schedule}. Examples: '0 9 * * *' (daily at 9am), '*/5 * * * *' (every 5 minutes), '0 0 * * 0' (weekly on Sunday)`
                );
            }

            // Resolve target agent to pubkey if specified - throw for invalid slugs (consistent with delegate tool)
            let toPubkey: string;
            if (targetAgent) {
                const resolution = resolveAgentSlug(targetAgent);
                if (!resolution.pubkey) {
                    const availableSlugsStr = resolution.availableSlugs.length > 0
                        ? `Available agent slugs: ${resolution.availableSlugs.join(", ")}`
                        : "No agents available in the current project context.";
                    throw new Error(
                        `Invalid agent slug: "${targetAgent}". Only agent slugs are accepted. ${availableSlugsStr}`
                    );
                }
                toPubkey = resolution.pubkey;
            } else {
                // Default to self if no target specified
                toPubkey = context.agent.pubkey;
            }

            const schedulerService = SchedulerService.getInstance();

            // The agent scheduling the task is always the current agent
            const fromPubkey = context.agent.pubkey;

            // Add task to scheduler with both pubkeys and optional title
            const taskId = await schedulerService.addTask(
                schedule,
                prompt,
                fromPubkey,
                toPubkey,
                undefined, // projectId - let it be resolved from context
                title
            );

            logger.info(
                `Successfully created scheduled task ${taskId} with cron schedule: ${schedule}`
            );

            return {
                success: true,
                taskId,
                message: `Task scheduled successfully with ID: ${taskId}`,
                title,
                schedule,
                prompt,
                targetAgent: targetAgent || "self",
            };
        },
    });

    // Attach getHumanReadableContent as non-enumerable property
    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: (args: { title?: string; prompt: string; schedule: string; targetAgent?: string }) => {
            const target = args.targetAgent ? ` for ${args.targetAgent}` : "";
            const titlePart = args.title ? `'${args.title}' ` : "";
            return `Scheduling task ${titlePart}with cron '${args.schedule}'${target}: ${args.prompt}`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
