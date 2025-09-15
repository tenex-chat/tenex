import { tool } from "ai";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";
import { SchedulerService } from "@/services/SchedulerService";
import { logger } from "@/utils/logger";
import { resolveRecipientToPubkey } from "@/utils/agent-resolution";
import * as cron from 'node-cron';

/**
 * Creates a tool for scheduling tasks using cron notation
 */
export function createScheduleTaskTool(context: ExecutionContext) {
  const aiTool = tool({
    description: "Schedule a task using cron notation (e.g., '0 9 * * *' for daily at 9am, '*/5 * * * *' for every 5 minutes)",
    inputSchema: z.object({
      prompt: z.string().describe("The prompt to execute when the task runs"),
      schedule: z.string().describe("Cron expression for scheduling (e.g., '0 9 * * *' for daily at 9am, '0 * * * *' for hourly)"),
      targetAgent: z.string().optional().describe("Target agent slug (e.g., 'architect'), name (e.g., 'Architect'), npub, or hex pubkey"),
    }),
    execute: async ({ prompt, schedule, targetAgent }) => {
      try {
        // Validate cron expression
        if (!cron.validate(schedule)) {
          return {
            success: false,
            error: `Invalid cron expression: ${schedule}. Examples: '0 9 * * *' (daily at 9am), '*/5 * * * *' (every 5 minutes), '0 0 * * 0' (weekly on Sunday)`,
          };
        }

        const schedulerService = SchedulerService.getInstance();

        // Resolve target agent to pubkey if specified
        let agentPubkey: string | undefined;
        if (targetAgent) {
          const resolved = resolveRecipientToPubkey(targetAgent);
          if (!resolved) {
            return {
              success: false,
              error: `Could not resolve target agent: ${targetAgent}. Use agent slug (e.g., 'architect'), name, npub, or hex pubkey.`,
            };
          }
          agentPubkey = resolved;
        } else {
          // Use the current agent's pubkey
          agentPubkey = context.agent.pubkey;
        }

        // Add task to scheduler
        const taskId = await schedulerService.addTask(schedule, prompt, agentPubkey);

        logger.info(`Successfully created scheduled task ${taskId} with cron schedule: ${schedule}`);

        return {
          success: true,
          taskId,
          message: `Task scheduled successfully with ID: ${taskId}`,
          schedule,
          prompt,
          targetAgent: targetAgent || 'self',
        };
      } catch (error: any) {
        logger.error("Failed to schedule task:", error);

        return {
          success: false,
          error: error.message || "Failed to schedule task",
        };
      }
    },
  });

  // Attach getHumanReadableContent as non-enumerable property
  Object.defineProperty(aiTool, 'getHumanReadableContent', {
    value: (args: { prompt: string; schedule: string; targetAgent?: string }) => {
      const target = args.targetAgent ? ` for ${args.targetAgent}` : '';
      return `Scheduling task with cron '${args.schedule}'${target}: ${args.prompt}`;
    },
    enumerable: false,
    configurable: true
  });

  return aiTool;
}