import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { getOrCreateTenexFsTools, getOrCreateHomeFsTools } from "@/tools/implementations/fs-tools-factory";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    const tenexFs = getOrCreateTenexFsTools(context);
    const homeFs = getOrCreateHomeFsTools(context);

    return {
        fs_read: tenexFs.fs_read as AISdkTool,
        fs_glob: tenexFs.fs_glob as AISdkTool,
        fs_grep: tenexFs.fs_grep as AISdkTool,
        home_fs_read: homeFs.home_fs_read as AISdkTool,
        home_fs_glob: homeFs.home_fs_glob as AISdkTool,
        home_fs_grep: homeFs.home_fs_grep as AISdkTool,
    };
}
