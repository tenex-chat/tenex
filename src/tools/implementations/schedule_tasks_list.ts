import type { ToolExecutionContext } from "@/tools/types";
import { SchedulerService } from "@/services/scheduling";
import { getProjectContext } from "@/services/projects";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

/**
 * Creates a tool for listing scheduled tasks
 */
export function createListScheduledTasksTool(_context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description: "List scheduled tasks for the current project",
        inputSchema: z.object({
            // Status filter is simplified since we don't track all these states locally
        }),
        execute: async () => {
            try {
                const schedulerService = SchedulerService.getInstance();

                // Get the current project ID from context
                let projectId: string | undefined;
                try {
                    const projectCtx = getProjectContext();
                    projectId = projectCtx.project.tagId();
                } catch {
                    // No project context available - this shouldn't happen in normal operation
                    // but we handle it gracefully by returning no tasks
                    logger.warn("No project context available when listing scheduled tasks");
                }

                // Get tasks from scheduler, filtered by current project
                const tasks = await schedulerService.getTasks(projectId);

                // Format tasks for output
                const formattedTasks = tasks.map((task) => ({
                    id: task.id,
                    title: task.title,
                    prompt: task.prompt,
                    createdAt: task.createdAt,
                    schedule: task.schedule,
                    lastRun: task.lastRun,
                    nextRun: task.nextRun,
                    toPubkey: task.toPubkey,
                }));

                logger.info(`Retrieved ${formattedTasks.length} scheduled tasks`);

                return {
                    success: true,
                    tasks: formattedTasks,
                    count: formattedTasks.length,
                };
            } catch (error: unknown) {
                logger.error("Failed to list scheduled tasks:", error);

                return {
                    success: false,
                    error:
                        error instanceof Error ? error.message : "Failed to list scheduled tasks",
                };
            }
        },
    });

    // Attach getHumanReadableContent as non-enumerable property
    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: () => {
            return "Listing scheduled tasks for current project";
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
