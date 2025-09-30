import { tool } from "ai";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/registry";
import { logger } from "@/utils/logger";
import { SchedulerService } from "@/services/SchedulerService";

/**
 * Creates a tool for listing scheduled tasks
 */
export function createListScheduledTasksTool(_context: ExecutionContext): AISdkTool {
  const aiTool = tool({
    description: "List all currently scheduled tasks",
    inputSchema: z.object({
      // Status filter is simplified since we don't track all these states locally
    }),
    execute: async () => {
      try {
        const schedulerService = SchedulerService.getInstance();

        // Get tasks from scheduler
        const tasks = await schedulerService.getTasks();

        // Format tasks for output
        const formattedTasks = tasks.map(task => ({
          id: task.id,
          prompt: task.prompt,
          createdAt: task.createdAt,
          schedule: task.schedule,
          lastRun: task.lastRun,
          nextRun: task.nextRun,
          agentPubkey: task.agentPubkey,
        }));

        logger.info(`Retrieved ${formattedTasks.length} scheduled tasks`);

        return {
          success: true,
          tasks: formattedTasks,
          count: formattedTasks.length,
        };
      } catch (error: any) {
        logger.error("Failed to list scheduled tasks:", error);

        return {
          success: false,
          error: error.message || "Failed to list scheduled tasks",
        };
      }
    },
  });

  // Attach getHumanReadableContent as non-enumerable property
  Object.defineProperty(aiTool, 'getHumanReadableContent', {
    value: () => {
      return `Listing all scheduled tasks`;
    },
    enumerable: false,
    configurable: true
  });

  return aiTool;
}