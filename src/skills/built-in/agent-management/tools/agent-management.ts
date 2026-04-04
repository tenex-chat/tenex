import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { createAgentsWriteTool } from "@/tools/implementations/agents_write";
import { createModifyProjectTool } from "@/tools/implementations/modify_project";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    return {
        agents_write: createAgentsWriteTool(context),
        modify_project: createModifyProjectTool(context),
    };
}
