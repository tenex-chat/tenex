import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { createProjectListTool } from "@/tools/implementations/project_list";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    return {
        project_list: createProjectListTool(context),
    };
}
