import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { createAgentsWriteTool } from "@/tools/implementations/agents_write";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    return {
        agents_write: createAgentsWriteTool(context),
    };
}
