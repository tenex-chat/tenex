import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { getOrCreateTenexFsTools } from "@/tools/implementations/fs-tools-factory";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    const tenexFs = getOrCreateTenexFsTools(context);

    return {
        fs_read: tenexFs.fs_read as AISdkTool,
        fs_glob: tenexFs.fs_glob as AISdkTool,
        fs_grep: tenexFs.fs_grep as AISdkTool,
    };
}
