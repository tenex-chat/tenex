import type { ExecutionContext } from "@/agents/execution/types";
import { SchedulerService } from "@/services/scheduling";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

/**
 * Creates a tool for canceling scheduled tasks
 */
export function createCancelScheduledTaskTool(_context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description: "Cancel a scheduled task by its ID",
        inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel"),
        }),
        execute: async ({ taskId }) => {
            try {
                const schedulerService = SchedulerService.getInstance();

                // Remove task from scheduler
                const success = await schedulerService.removeTask(taskId);

                if (!success) {
                    return {
                        success: false,
                        error: `Task ${taskId} not found or could not be removed`,
                        taskId,
                    };
                }

                logger.info(`Successfully cancelled scheduled task ${taskId}`);

                return {
                    success: true,
                    message: `Task ${taskId} cancelled successfully`,
                    taskId,
                };
            } catch (error: unknown) {
                logger.error(`Failed to cancel scheduled task ${taskId}:`, error);

                return {
                    success: false,
                    error:
                        error instanceof Error ? error.message : "Failed to cancel scheduled task",
                    taskId,
                };
            }
        },
    });

    // Attach getHumanReadableContent as non-enumerable property
    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: (args: { taskId: string }) => {
            return `Canceling scheduled task ${args.taskId}`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
