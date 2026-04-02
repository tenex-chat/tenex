import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { getOrCreateTenexFsTools, getOrCreateHomeFsTools } from "@/tools/implementations/fs-tools-factory";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    const tenexFs = getOrCreateTenexFsTools(context);
    const homeFs = getOrCreateHomeFsTools(context);

    return {
        fs_write: tenexFs.fs_write as AISdkTool,
        fs_edit: tenexFs.fs_edit as AISdkTool,
        home_fs_write: homeFs.home_fs_write as AISdkTool,
        home_fs_edit: homeFs.home_fs_edit as AISdkTool,
    };
}
