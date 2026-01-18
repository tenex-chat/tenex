import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { killBackgroundTask, getBackgroundTaskInfo, getAllBackgroundTasks } from "./shell";
import { tool } from "ai";
import { z } from "zod";

const killShellSchema = z.object({
    taskId: z
        .string()
        .min(1, "taskId is required")
        .describe("The task ID of the background shell process to terminate. Obtain this from the shell tool's response when run_in_background is true."),
});

type KillShellInput = z.infer<typeof killShellSchema>;

interface KillShellOutput {
    success: boolean;
    message: string;
    taskId: string;
    pid?: number;
    taskInfo?: {
        command: string;
        description: string | null;
        outputFile: string;
        startTime: string;
    };
}

/**
 * Core implementation of the kill_shell functionality
 */
function executeKillShell(input: KillShellInput): KillShellOutput {
    const { taskId } = input;

    // Get task info before killing (for reporting)
    const taskInfo = getBackgroundTaskInfo(taskId);

    // Attempt to kill the task
    const result = killBackgroundTask(taskId);

    const output: KillShellOutput = {
        success: result.success,
        message: result.message,
        taskId,
        pid: result.pid,
    };

    // Include task info if it was found
    if (taskInfo) {
        output.taskInfo = {
            command: taskInfo.command,
            description: taskInfo.description,
            outputFile: taskInfo.outputFile,
            startTime: taskInfo.startTime.toISOString(),
        };
    }

    // If task not found, suggest listing tasks
    if (!result.success && !taskInfo) {
        const allTasks = getAllBackgroundTasks();
        if (allTasks.length > 0) {
            output.message += `\n\nAvailable background tasks: ${allTasks.map(t => t.taskId).join(", ")}`;
        } else {
            output.message += "\n\nNo background tasks are currently running.";
        }
    }

    return output;
}

/**
 * Create an AI SDK tool for killing background shell processes
 */
export function createKillShellTool(_context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description: `Terminate a background shell process by its task ID. Use this to stop long-running processes that were started with the shell tool's run_in_background option. Returns success status and process information.`,

        inputSchema: killShellSchema,

        execute: async (input: KillShellInput) => {
            return executeKillShell(input);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ taskId }: KillShellInput) => {
            return `Killing background task ${taskId}`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
