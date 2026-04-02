import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { createShellTool } from "@/tools/implementations/shell";
import { createScheduleTaskTool } from "@/tools/implementations/schedule_task";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    return {
        shell: createShellTool(context),
        schedule_task: createScheduleTaskTool(context),
    };
}
