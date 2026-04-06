import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { createReportPublishTool } from "@/tools/implementations/report_publish";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    return {
        report_publish: createReportPublishTool(context),
    };
}
