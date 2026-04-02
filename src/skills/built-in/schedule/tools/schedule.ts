import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { createScheduleTaskTool } from "@/tools/implementations/schedule_task";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    return {
        schedule_task: createScheduleTaskTool(context),
    };
}
