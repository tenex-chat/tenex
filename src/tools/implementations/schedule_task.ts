import type { ToolExecutionContext } from "@/tools/types";
import { SchedulerService } from "@/services/scheduling";
import { formatDelay, formatExecuteAt, parseRelativeDelay } from "@/services/scheduling/utils";
import type { AISdkTool } from "@/tools/types";
import { resolveAgentSlug } from "@/services/agents";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import * as cron from "node-cron";
import { z } from "zod";

/**
 * Creates a unified tool for scheduling tasks — supports both cron (recurring) and relative delay (one-off).
 */
export function createScheduleTaskTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Schedule a task using a cron expression for recurring tasks (e.g. '0 9 * * *') or a relative delay for one-off tasks (e.g. '5m', '2h', '1d')",
        inputSchema: z.object({
            prompt: z.string().describe("The prompt to execute when the task runs"),
            when: z.string().describe(
                "When to execute. Use a cron expression for recurring tasks (e.g. '0 9 * * *' for daily at 9am, '*/5 * * * *' for every 5 minutes), or a relative delay for one-off tasks (e.g. '5m', '2h', '1d')"
            ),
            title: z.string().optional().describe("A human-readable title for the task"),
            targetAgent: z
                .string()
                .nullable()
                .optional()
                .describe(
                    "Target agent slug (e.g., 'architect', 'claude-code'). Defaults to self."
                ),
        }),
        execute: async ({ prompt, when, title, targetAgent }) => {
            // Resolve target agent
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
                toPubkey = context.agent.pubkey;
            }

            const schedulerService = SchedulerService.getInstance();
            const fromPubkey = context.agent.pubkey;

            // Try relative delay first
            const delayMs = parseRelativeDelay(when);
            if (delayMs !== null) {
                const executeAt = new Date(Date.now() + delayMs);
                const taskId = await schedulerService.addOneoffTask(
                    executeAt,
                    prompt,
                    fromPubkey,
                    toPubkey,
                    undefined,
                    title
                );

                logger.info(
                    `Successfully created one-off task ${taskId} to execute at: ${executeAt.toISOString()}`
                );

                return {
                    success: true,
                    taskId,
                    type: "oneoff" as const,
                    message: `One-off task scheduled successfully with ID: ${taskId}`,
                    title,
                    delay: when,
                    delayHuman: formatDelay(when),
                    executeAt: executeAt.toISOString(),
                    executeAtFormatted: formatExecuteAt(executeAt.toISOString()),
                    prompt,
                    targetAgent: targetAgent || "self",
                };
            }

            // Try cron
            if (cron.validate(when)) {
                const taskId = await schedulerService.addTask(
                    when,
                    prompt,
                    fromPubkey,
                    toPubkey,
                    undefined,
                    title
                );

                logger.info(
                    `Successfully created scheduled task ${taskId} with cron schedule: ${when}`
                );

                return {
                    success: true,
                    taskId,
                    type: "cron" as const,
                    message: `Task scheduled successfully with ID: ${taskId}`,
                    title,
                    schedule: when,
                    prompt,
                    targetAgent: targetAgent || "self",
                };
            }

            // Neither format matched
            throw new Error(
                `Invalid 'when' value: "${when}". Use a cron expression (e.g. '0 9 * * *' for daily at 9am) or a relative delay (e.g. '5m', '2h', '1d').`
            );
        },
    });

    return aiTool as AISdkTool;
}
