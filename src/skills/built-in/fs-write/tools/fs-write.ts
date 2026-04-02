import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { getOrCreateTenexFsTools } from "@/tools/implementations/fs-tools-factory";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    const tenexFs = getOrCreateTenexFsTools(context);

    return {
        fs_write: tenexFs.fs_write as AISdkTool,
        fs_edit: tenexFs.fs_edit as AISdkTool,
    };
}
